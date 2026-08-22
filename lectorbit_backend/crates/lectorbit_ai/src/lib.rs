//! Backend-only adapters for verified local AI models and whisper.cpp.
//!
//! The renderer never supplies paths or process arguments. Callers resolve an
//! authorized media ID, a verified model ID, and configured sidecars first.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use fs2::available_space;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub const EXPECTED_WHISPER_VERSION: &str = "1.9.2";
pub const EXPECTED_FFMPEG_VERSION: &str = "8.1.2";
pub const MODEL_CATALOG_VERSION: &str = "2026-08-20";

const SIDECAR_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TranscriptionLanguage {
    #[serde(rename = "en")]
    English,
    #[serde(rename = "bn")]
    Bangla,
}

impl TranscriptionLanguage {
    pub const fn code(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Bangla => "bn",
        }
    }
}

impl Default for TranscriptionLanguage {
    fn default() -> Self {
        Self::English
    }
}

impl TryFrom<&str> for TranscriptionLanguage {
    type Error = AiError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "en" => Ok(Self::English),
            "bn" => Ok(Self::Bangla),
            _ => Err(AiError::UnsupportedLanguage),
        }
    }
}

pub fn supported_languages_for_model(model_id: &str) -> &'static [&'static str] {
    match model_id {
        "whisper-base.en" => &["en"],
        "whisper-base" => &["en", "bn"],
        _ => &[],
    }
}

pub fn model_supports_language(model_id: &str, language: TranscriptionLanguage) -> bool {
    supported_languages_for_model(model_id).contains(&language.code())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelManifest {
    pub id: String,
    pub version: String,
    pub provider: String,
    pub source_url: String,
    pub expected_size_bytes: u64,
    pub sha256: String,
    pub architecture: String,
    pub analyzer_compatibility: String,
    pub license: String,
}

#[derive(Debug, Deserialize)]
struct ModelCatalog {
    schema_version: u32,
    catalog_version: String,
    models: Vec<ModelManifest>,
}

/// Audited model catalog. Model bytes are downloaded only after an explicit
/// user action and verified before they can be selected for transcription.
pub fn builtin_models() -> Vec<ModelManifest> {
    let catalog: ModelCatalog = serde_json::from_str(include_str!("../model-catalog.json"))
        .expect("embedded model catalog must be valid JSON");
    assert_eq!(
        catalog.schema_version, 1,
        "unsupported model catalog schema"
    );
    assert_eq!(
        catalog.catalog_version, MODEL_CATALOG_VERSION,
        "model catalog version mismatch"
    );
    catalog.models
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptOutput {
    pub language: String,
    pub segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Error)]
pub enum AiError {
    #[error("the configured sidecar is unavailable")]
    SidecarUnavailable,
    #[error("the configured sidecar version is unsupported")]
    UnsupportedVersion,
    #[error("the configured FFmpeg sidecar is unavailable")]
    FfmpegUnavailable,
    #[error("the configured FFmpeg sidecar version is unsupported")]
    UnsupportedFfmpegVersion,
    #[error("the model manifest is invalid")]
    InvalidManifest,
    #[error("there is not enough free disk space for this model")]
    InsufficientDiskSpace,
    #[error("model download failed")]
    DownloadFailed,
    #[error("downloaded model failed verification")]
    VerificationFailed,
    #[error("media audio extraction failed")]
    ExtractionFailed,
    #[error("local transcription failed")]
    TranscriptionFailed,
    #[error("local transcription returned invalid output")]
    InvalidOutput,
    #[error("the requested transcription language is unsupported")]
    UnsupportedLanguage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

/// Download a model into a backend-owned directory, resuming an interrupted
/// `.partial` file and atomically publishing only hash-verified bytes.
pub async fn install_model(
    client: &reqwest::Client,
    manifest: &ModelManifest,
    models_dir: &Path,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<PathBuf, AiError> {
    validate_manifest(manifest)?;
    tokio::fs::create_dir_all(models_dir)
        .await
        .map_err(|_| AiError::DownloadFailed)?;
    let partial = models_dir.join(format!("{}.partial", manifest.id));
    let destination = models_dir.join(format!("{}.bin", manifest.id));
    let mut existing = tokio::fs::metadata(&partial)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if existing > manifest.expected_size_bytes {
        tokio::fs::remove_file(&partial)
            .await
            .map_err(|_| AiError::DownloadFailed)?;
        existing = 0;
    }
    if existing == manifest.expected_size_bytes {
        if sha256_file(&partial).await? == manifest.sha256.to_ascii_lowercase() {
            publish_verified_model(&partial, &destination).await?;
            return Ok(destination);
        }
        tokio::fs::remove_file(&partial)
            .await
            .map_err(|_| AiError::DownloadFailed)?;
        existing = 0;
    }
    let required = manifest.expected_size_bytes.saturating_sub(existing);
    let free = available_space(models_dir).map_err(|_| AiError::InsufficientDiskSpace)?;
    // Keep a small reserve for SQLite/temp files while the model is installed.
    if free < required.saturating_add(32 * 1024 * 1024) {
        return Err(AiError::InsufficientDiskSpace);
    }

    let mut request = client.get(&manifest.source_url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let response = request.send().await.map_err(|_| AiError::DownloadFailed)?;
    let resumed = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !response.status().is_success() {
        return Err(AiError::DownloadFailed);
    }
    let mut downloaded = if resumed { existing } else { 0 };
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if resumed {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(&partial)
        .await
        .map_err(|_| AiError::DownloadFailed)?;
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AiError::DownloadFailed)?
    {
        file.write_all(&chunk)
            .await
            .map_err(|_| AiError::DownloadFailed)?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > manifest.expected_size_bytes {
            return Err(AiError::VerificationFailed);
        }
        on_progress(DownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: manifest.expected_size_bytes,
        });
    }
    file.flush().await.map_err(|_| AiError::DownloadFailed)?;
    drop(file);

    if downloaded != manifest.expected_size_bytes {
        return Err(AiError::VerificationFailed);
    }
    let actual = sha256_file(&partial).await?;
    if actual != manifest.sha256.to_ascii_lowercase() {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(AiError::VerificationFailed);
    }
    publish_verified_model(&partial, &destination).await?;
    Ok(destination)
}

async fn publish_verified_model(partial: &Path, destination: &Path) -> Result<(), AiError> {
    if tokio::fs::metadata(&destination).await.is_ok() {
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|_| AiError::DownloadFailed)?;
    }
    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|_| AiError::DownloadFailed)?;
    Ok(())
}

pub async fn verify_model_file(manifest: &ModelManifest, path: &Path) -> Result<(), AiError> {
    validate_manifest(manifest)?;
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| AiError::VerificationFailed)?;
    if !metadata.is_file() || metadata.len() != manifest.expected_size_bytes {
        return Err(AiError::VerificationFailed);
    }
    if sha256_file(path).await? != manifest.sha256.to_ascii_lowercase() {
        return Err(AiError::VerificationFailed);
    }
    Ok(())
}

pub fn validate_manifest(manifest: &ModelManifest) -> Result<(), AiError> {
    let valid_id = !manifest.id.is_empty()
        && manifest.id.len() <= 64
        && manifest.id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        });
    let valid_hash = manifest.sha256.len() == 64
        && manifest
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if !valid_id
        || !valid_hash
        || manifest.expected_size_bytes == 0
        || !manifest.source_url.starts_with("https://")
        || manifest.analyzer_compatibility != EXPECTED_WHISPER_VERSION
    {
        return Err(AiError::InvalidManifest);
    }
    Ok(())
}

async fn sha256_file(path: &Path) -> Result<String, AiError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| AiError::VerificationFailed)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| AiError::VerificationFailed)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Clone)]
pub struct WhisperCpp {
    whisper_cli: PathBuf,
    ffmpeg: PathBuf,
}

impl WhisperCpp {
    pub fn new(whisper_cli: PathBuf, ffmpeg: PathBuf) -> Result<Self, AiError> {
        if !whisper_cli.is_absolute()
            || !whisper_cli.is_file()
            || !ffmpeg.is_absolute()
            || !ffmpeg.is_file()
        {
            return Err(AiError::SidecarUnavailable);
        }
        Ok(Self {
            whisper_cli,
            ffmpeg,
        })
    }

    pub async fn verify_version(&self) -> Result<(), AiError> {
        let output = tokio::time::timeout(
            SIDECAR_PROBE_TIMEOUT,
            Command::new(&self.whisper_cli)
                .arg("--version")
                .stdin(Stdio::null())
                .stderr(Stdio::piped())
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| AiError::SidecarUnavailable)?
        .map_err(|_| AiError::SidecarUnavailable)?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if !output.status.success()
            || !contains_pinned_version(&text, "whisper.cpp version:", EXPECTED_WHISPER_VERSION)
        {
            return Err(AiError::UnsupportedVersion);
        }
        Ok(())
    }

    pub async fn verify_ffmpeg_version(&self) -> Result<(), AiError> {
        let output = tokio::time::timeout(
            SIDECAR_PROBE_TIMEOUT,
            Command::new(&self.ffmpeg)
                .arg("-version")
                .stdin(Stdio::null())
                .stderr(Stdio::piped())
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| AiError::FfmpegUnavailable)?
        .map_err(|_| AiError::FfmpegUnavailable)?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if !output.status.success()
            || !contains_pinned_version(&text, "ffmpeg version", EXPECTED_FFMPEG_VERSION)
        {
            return Err(AiError::UnsupportedFfmpegVersion);
        }
        Ok(())
    }

    pub async fn transcribe(
        &self,
        media_path: &Path,
        model_path: &Path,
        work_dir: &Path,
        language: TranscriptionLanguage,
    ) -> Result<TranscriptOutput, AiError> {
        if !media_path.is_absolute()
            || !media_path.is_file()
            || !model_path.is_absolute()
            || !model_path.is_file()
            || !work_dir.is_absolute()
        {
            return Err(AiError::SidecarUnavailable);
        }
        tokio::fs::create_dir_all(work_dir)
            .await
            .map_err(|_| AiError::ExtractionFailed)?;
        let audio_path = work_dir.join("audio.wav");
        let output_base = work_dir.join("transcript");
        let extraction = Command::new(&self.ffmpeg)
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(media_path)
            .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
            .arg(&audio_path)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status()
            .await
            .map_err(|_| AiError::ExtractionFailed)?;
        if !extraction.success() {
            return Err(AiError::ExtractionFailed);
        }
        let transcription = Command::new(&self.whisper_cli)
            .args([
                "--output-json",
                "--no-prints",
                "--language",
                language.code(),
                "--model",
            ])
            .arg(model_path)
            .arg("--output-file")
            .arg(&output_base)
            .arg("--file")
            .arg(&audio_path)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status()
            .await
            .map_err(|_| AiError::TranscriptionFailed)?;
        if !transcription.success() {
            return Err(AiError::TranscriptionFailed);
        }
        let json_path = output_base.with_extension("json");
        let bytes = tokio::fs::read(json_path)
            .await
            .map_err(|_| AiError::InvalidOutput)?;
        parse_whisper_json(&bytes)
    }
}

fn contains_pinned_version(output: &str, marker: &str, expected: &str) -> bool {
    output.lines().any(|line| {
        let Some((_, suffix)) = line.split_once(marker) else {
            return false;
        };
        let suffix = suffix.trim_start();
        let Some(remainder) = suffix.strip_prefix(expected) else {
            return false;
        };
        remainder
            .chars()
            .next()
            .is_none_or(|character| character.is_whitespace() || matches!(character, '-' | '('))
    })
}

#[derive(Deserialize)]
struct WhisperDocument {
    result: WhisperResult,
    transcription: Vec<WhisperSegment>,
}

#[derive(Deserialize)]
struct WhisperResult {
    language: String,
}

#[derive(Deserialize)]
struct WhisperSegment {
    offsets: WhisperOffsets,
    text: String,
}

#[derive(Deserialize)]
struct WhisperOffsets {
    from: u64,
    to: u64,
}

pub fn parse_whisper_json(bytes: &[u8]) -> Result<TranscriptOutput, AiError> {
    let document: WhisperDocument =
        serde_json::from_slice(bytes).map_err(|_| AiError::InvalidOutput)?;
    let segments = document
        .transcription
        .into_iter()
        .filter_map(|segment| {
            let text = segment.text.trim().to_string();
            (segment.offsets.to > segment.offsets.from && !text.is_empty()).then_some(
                TranscriptSegment {
                    start_ms: segment.offsets.from,
                    end_ms: segment.offsets.to,
                    text,
                },
            )
        })
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return Err(AiError::InvalidOutput);
    }
    Ok(TranscriptOutput {
        language: document.result.language,
        segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_manifest_is_valid() {
        for model in builtin_models() {
            validate_manifest(&model).expect("valid catalog");
            assert!(
                !supported_languages_for_model(&model.id).is_empty(),
                "catalog model {} must declare an explicit language policy",
                model.id
            );
        }
    }

    #[test]
    fn rejects_traversal_model_ids() {
        let mut model = builtin_models().remove(0);
        model.id = "../model".into();
        assert!(matches!(
            validate_manifest(&model),
            Err(AiError::InvalidManifest)
        ));
    }

    #[test]
    fn parses_timestamped_json_and_ignores_blank_segments() {
        let output = parse_whisper_json(
            br#"{
              "result":{"language":"en"},
              "transcription":[
                {"offsets":{"from":120,"to":980},"text":" Hello world "},
                {"offsets":{"from":980,"to":1100},"text":"   "}
              ]
            }"#,
        )
        .expect("parse");
        assert_eq!(output.language, "en");
        assert_eq!(output.segments.len(), 1);
        assert_eq!(output.segments[0].start_ms, 120);
        assert_eq!(output.segments[0].text, "Hello world");
    }

    #[test]
    fn maps_supported_transcription_languages_to_whisper_codes() {
        assert_eq!(TranscriptionLanguage::English.code(), "en");
        assert_eq!(TranscriptionLanguage::Bangla.code(), "bn");
        assert!(TranscriptionLanguage::try_from("auto").is_err());
    }

    #[test]
    fn english_models_reject_bangla_but_multilingual_models_accept_it() {
        assert!(model_supports_language(
            "whisper-base.en",
            TranscriptionLanguage::English
        ));
        assert!(!model_supports_language(
            "whisper-base.en",
            TranscriptionLanguage::Bangla
        ));
        assert!(model_supports_language(
            "whisper-base",
            TranscriptionLanguage::Bangla
        ));
        assert!(!model_supports_language(
            "unknown-model",
            TranscriptionLanguage::English
        ));
    }

    #[test]
    fn parses_bangla_transcript_without_losing_unicode() {
        let document = r#"{
              "result":{"language":"bn"},
              "transcription":[
                {"offsets":{"from":0,"to":1500},"text":" মেশিন লার্নিং কী? "}
              ]
            }"#;
        let output = parse_whisper_json(document.as_bytes()).expect("parse Bangla transcript");
        assert_eq!(output.language, "bn");
        assert_eq!(output.segments[0].text, "মেশিন লার্নিং কী?");
    }

    #[test]
    fn sidecar_version_matching_requires_the_exact_pinned_release() {
        assert!(contains_pinned_version(
            "whisper.cpp version: 1.9.2\n",
            "whisper.cpp version:",
            EXPECTED_WHISPER_VERSION
        ));
        assert!(contains_pinned_version(
            "ffmpeg version 8.1.2-full_build-www.gyan.dev Copyright",
            "ffmpeg version",
            EXPECTED_FFMPEG_VERSION
        ));
        assert!(!contains_pinned_version(
            "ffmpeg version 8.1.20",
            "ffmpeg version",
            EXPECTED_FFMPEG_VERSION
        ));
    }
}
