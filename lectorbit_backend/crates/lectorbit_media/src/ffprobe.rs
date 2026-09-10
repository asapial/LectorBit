//! Pinned ffprobe adapter. Commands are always launched with argument arrays;
//! renderer-controlled strings never become a shell command.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use thiserror::Error;
use tokio::process::Command;
use tokio::time::timeout;

pub const EXPECTED_FFPROBE_VERSION: &str = "8.1.2";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProbeError {
    #[error("ffprobe executable is not configured")]
    Unavailable,
    #[error("Windows Application Control blocked ffprobe")]
    LaunchBlocked,
    #[error("ffprobe executable path must be absolute")]
    InvalidExecutable,
    #[error("media path must be an absolute file path")]
    InvalidMediaPath,
    #[error("ffprobe did not finish in time")]
    TimedOut,
    #[error("ffprobe version does not match the pinned release")]
    VersionMismatch,
    #[error("ffprobe could not inspect this media")]
    ProcessFailed,
    #[error("ffprobe returned too much metadata")]
    OutputTooLarge,
    #[error("ffprobe returned invalid JSON")]
    InvalidJson,
    #[error("media duration is unavailable")]
    MissingDuration,
}

impl ProbeError {
    pub fn safe_message(&self) -> &'static str {
        match self {
            Self::Unavailable | Self::InvalidExecutable | Self::VersionMismatch => {
                "Media inspection is not available in this installation."
            }
            Self::LaunchBlocked => {
                "Windows Application Control blocked media inspection. Install an approved, signed LectorBit package."
            }
            Self::TimedOut => "Media inspection timed out.",
            Self::InvalidMediaPath
            | Self::ProcessFailed
            | Self::OutputTooLarge
            | Self::InvalidJson
            | Self::MissingDuration => "This file could not be inspected.",
        }
    }

    pub fn status(&self) -> &'static str {
        match self {
            Self::Unavailable
            | Self::LaunchBlocked
            | Self::InvalidExecutable
            | Self::VersionMismatch => "unavailable",
            _ => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Ffprobe {
    executable: PathBuf,
    timeout: Duration,
}

impl Ffprobe {
    pub fn new(executable: PathBuf) -> Result<Self, ProbeError> {
        if !executable.is_absolute() {
            return Err(ProbeError::InvalidExecutable);
        }
        Ok(Self {
            executable,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    #[cfg(test)]
    fn with_timeout(executable: PathBuf, timeout: Duration) -> Result<Self, ProbeError> {
        let mut adapter = Self::new(executable)?;
        adapter.timeout = timeout;
        Ok(adapter)
    }

    pub async fn verify_version(&self) -> Result<(), ProbeError> {
        let output = timeout(
            self.timeout,
            Command::new(&self.executable)
                .arg("-version")
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| ProbeError::TimedOut)?
        .map_err(map_launch_error)?;
        if !output.status.success() {
            return Err(ProbeError::Unavailable);
        }
        let first_line = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .to_string();
        if !first_line.contains(&format!("ffprobe version {EXPECTED_FFPROBE_VERSION}")) {
            return Err(ProbeError::VersionMismatch);
        }
        Ok(())
    }

    pub async fn probe(&self, media_path: &Path) -> Result<ProbeMetadata, ProbeError> {
        if !media_path.is_absolute() || !media_path.is_file() {
            return Err(ProbeError::InvalidMediaPath);
        }
        let output = timeout(
            self.timeout,
            Command::new(&self.executable)
                .args(probe_arguments(media_path))
                .stdin(Stdio::null())
                .stderr(Stdio::piped())
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| ProbeError::TimedOut)?
        .map_err(map_launch_error)?;
        if !output.status.success() {
            return Err(ProbeError::ProcessFailed);
        }
        if output.stdout.len() > MAX_JSON_BYTES {
            return Err(ProbeError::OutputTooLarge);
        }
        parse_probe_json(&output.stdout)
    }
}

fn map_launch_error(error: std::io::Error) -> ProbeError {
    #[cfg(windows)]
    if error.raw_os_error() == Some(4551) {
        return ProbeError::LaunchBlocked;
    }
    ProbeError::Unavailable
}

pub fn probe_arguments(media_path: &Path) -> Vec<OsString> {
    vec![
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-show_format".into(),
        "-show_streams".into(),
        "-of".into(),
        "json".into(),
        media_path.as_os_str().to_owned(),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeMetadata {
    pub duration_ms: u64,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub audio_streams: u32,
    pub subtitle_streams: u32,
    pub streams: Vec<ProbeStream>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeStream {
    pub index: u32,
    pub kind: String,
    pub codec: Option<String>,
    pub language: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bitrate: Option<u64>,
    pub duration_ms: Option<u64>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub is_default: bool,
}

#[derive(Debug, Deserialize, Default)]
struct ProbeDocument {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: Option<RawFormat>,
}

#[derive(Debug, Deserialize, Default)]
struct RawFormat {
    format_name: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    tags: RawTags,
}

#[derive(Debug, Deserialize, Default)]
struct RawStream {
    index: Option<u32>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    bit_rate: Option<String>,
    duration: Option<String>,
    channels: Option<u32>,
    sample_rate: Option<String>,
    #[serde(default)]
    tags: RawTags,
    #[serde(default)]
    disposition: RawDisposition,
}

#[derive(Debug, Deserialize, Default)]
struct RawTags {
    language: Option<String>,
    #[serde(alias = "DURATION")]
    duration: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    default: i32,
}

pub fn parse_probe_json(json: &[u8]) -> Result<ProbeMetadata, ProbeError> {
    let document: ProbeDocument =
        serde_json::from_slice(json).map_err(|_| ProbeError::InvalidJson)?;
    let mut streams = Vec::with_capacity(document.streams.len());
    let mut video_codec = None;
    let mut audio_codec = None;
    let mut width = None;
    let mut height = None;
    let mut audio_streams = 0_u32;
    let mut subtitle_streams = 0_u32;
    let mut stream_duration = None;

    for (fallback_index, raw) in document.streams.into_iter().enumerate() {
        let kind = raw.codec_type.unwrap_or_else(|| "data".into());
        let duration_ms = raw
            .duration
            .as_deref()
            .and_then(parse_duration_ms)
            .or_else(|| raw.tags.duration.as_deref().and_then(parse_duration_ms));
        stream_duration = stream_duration.max(duration_ms);
        if kind == "video" && video_codec.is_none() {
            video_codec = raw.codec_name.clone();
            width = raw.width;
            height = raw.height;
        }
        if kind == "audio" {
            audio_streams = audio_streams.saturating_add(1);
            if audio_codec.is_none() {
                audio_codec = raw.codec_name.clone();
            }
        }
        if kind == "subtitle" {
            subtitle_streams = subtitle_streams.saturating_add(1);
        }
        streams.push(ProbeStream {
            index: raw.index.unwrap_or_else(|| fallback_index as u32),
            kind,
            codec: raw.codec_name,
            language: raw.tags.language,
            width: raw.width,
            height: raw.height,
            bitrate: raw.bit_rate.as_deref().and_then(parse_integer),
            duration_ms,
            channels: raw.channels,
            sample_rate: raw
                .sample_rate
                .as_deref()
                .and_then(parse_integer)
                .and_then(|value| u32::try_from(value).ok()),
            is_default: raw.disposition.default == 1,
        });
    }

    let duration_ms = document
        .format
        .as_ref()
        .and_then(|format| {
            format
                .duration
                .as_deref()
                .and_then(parse_duration_ms)
                .or_else(|| format.tags.duration.as_deref().and_then(parse_duration_ms))
        })
        .or(stream_duration)
        .filter(|duration| *duration > 0)
        .ok_or(ProbeError::MissingDuration)?;
    let container = document.format.and_then(|format| {
        format
            .format_name
            .and_then(|names| names.split(',').next().map(str::to_string))
    });

    Ok(ProbeMetadata {
        duration_ms,
        container,
        video_codec,
        audio_codec,
        width,
        height,
        audio_streams,
        subtitle_streams,
        streams,
    })
}

fn parse_duration_ms(value: &str) -> Option<u64> {
    if value.contains(':') {
        return parse_clock_duration_ms(value);
    }
    let seconds = value.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let milliseconds = seconds * 1_000.0;
    if milliseconds > u64::MAX as f64 {
        return None;
    }
    Some(milliseconds.round() as u64)
}

fn parse_clock_duration_ms(value: &str) -> Option<u64> {
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<u64>().ok()?;
    let minutes = parts.next()?.parse::<u64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    if parts.next().is_some()
        || minutes >= 60
        || !seconds.is_finite()
        || !(0.0..60.0).contains(&seconds)
    {
        return None;
    }
    let milliseconds = ((hours as f64 * 3_600.0) + (minutes as f64 * 60.0) + seconds) * 1_000.0;
    if milliseconds > u64::MAX as f64 {
        return None;
    }
    Some(milliseconds.round() as u64)
}

fn parse_integer(value: &str) -> Option<u64> {
    value.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "streams": [
        {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"bit_rate":"3500000","duration":"65.432","disposition":{"default":1}},
        {"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"48000","tags":{"language":"eng"}},
        {"index":2,"codec_type":"subtitle","codec_name":"subrip","tags":{"language":"spa"}}
      ],
      "format": {"format_name":"matroska,webm","duration":"65.432"}
    }"#;

    #[test]
    fn parses_video_audio_subtitle_metadata() {
        let metadata = parse_probe_json(FIXTURE.as_bytes()).expect("metadata");
        assert_eq!(metadata.duration_ms, 65_432);
        assert_eq!(metadata.container.as_deref(), Some("matroska"));
        assert_eq!(metadata.video_codec.as_deref(), Some("h264"));
        assert_eq!(metadata.audio_codec.as_deref(), Some("aac"));
        assert_eq!((metadata.width, metadata.height), (Some(1920), Some(1080)));
        assert_eq!(metadata.audio_streams, 1);
        assert_eq!(metadata.subtitle_streams, 1);
        assert_eq!(metadata.streams[1].language.as_deref(), Some("eng"));
    }

    #[test]
    fn stream_duration_is_a_safe_fallback() {
        let json = br#"{"streams":[{"index":0,"codec_type":"audio","duration":"1.234"}]}"#;
        assert_eq!(parse_probe_json(json).expect("metadata").duration_ms, 1_234);
    }

    #[test]
    fn parses_ffprobe_duration_tags_used_by_some_mp4_and_matroska_files() {
        let json = br#"{
          "streams":[
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,
             "tags":{"DURATION":"00:01:05.432000000"}}
          ],
          "format":{"format_name":"matroska,webm"}
        }"#;
        let metadata = parse_probe_json(json).expect("tag duration");
        assert_eq!(metadata.duration_ms, 65_432);
        assert_eq!(metadata.video_codec.as_deref(), Some("h264"));
        assert_eq!((metadata.width, metadata.height), (Some(1280), Some(720)));
    }

    #[test]
    fn invalid_or_durationless_json_is_a_safe_failure() {
        assert_eq!(parse_probe_json(b"not json"), Err(ProbeError::InvalidJson));
        assert_eq!(
            parse_probe_json(br#"{"streams":[]}"#),
            Err(ProbeError::MissingDuration)
        );
    }

    #[test]
    fn suspicious_filename_remains_one_argument() {
        let path = if cfg!(windows) {
            PathBuf::from(r"C:\safe\lesson.mp4 & calc.exe")
        } else {
            PathBuf::from("/safe/lesson.mp4;rm -rf ignored")
        };
        let arguments = probe_arguments(&path);
        assert_eq!(arguments.len(), 8);
        assert_eq!(arguments.last(), Some(&path.into_os_string()));
    }

    #[test]
    fn executable_must_be_absolute() {
        assert_eq!(
            Ffprobe::with_timeout(PathBuf::from("ffprobe"), Duration::from_secs(1))
                .expect_err("relative"),
            ProbeError::InvalidExecutable
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_application_control_failure_is_distinct() {
        assert_eq!(
            map_launch_error(std::io::Error::from_raw_os_error(4551)),
            ProbeError::LaunchBlocked
        );
    }
}
