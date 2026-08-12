//! Backend-only playback adapter with a narrow mpv JSON-IPC boundary.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const EXPECTED_MPV_VERSION: &str = "0.41.0";

#[derive(Debug, Clone)]
pub struct PlaybackSource {
    pub media_id: String,
    pub canonical_path: PathBuf,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EngineState {
    pub position_ms: u64,
    pub duration_ms: u64,
    pub paused: bool,
    pub speed: f64,
}

#[derive(Debug, Error)]
pub enum PlaybackError {
    #[error("playback is unavailable")]
    Unavailable,
    #[error("the playback process could not be started")]
    StartFailed,
    #[error("the playback control channel is unavailable")]
    IpcUnavailable,
    #[error("the playback command failed")]
    CommandFailed,
    #[error("the playback state is invalid")]
    InvalidState,
}

#[async_trait]
pub trait PlaybackEngine: Send + Sync {
    async fn probe(&self) -> Result<String, PlaybackError>;
    async fn open(&self, source: PlaybackSource) -> Result<EngineState, PlaybackError>;
    async fn play(&self) -> Result<(), PlaybackError>;
    async fn pause(&self) -> Result<(), PlaybackError>;
    async fn seek(&self, position_ms: u64) -> Result<(), PlaybackError>;
    async fn set_speed(&self, multiplier: f64) -> Result<(), PlaybackError>;
    async fn state(&self) -> Result<EngineState, PlaybackError>;
    async fn close(&self) -> Result<(), PlaybackError>;
}

struct MpvSession {
    child: Child,
    endpoint: String,
}

pub struct MpvEngine {
    executable: OsString,
    session: Mutex<Option<MpvSession>>,
    request_id: AtomicU64,
}

impl MpvEngine {
    pub fn new(executable: impl Into<OsString>) -> Self {
        Self {
            executable: executable.into(),
            session: Mutex::new(None),
            request_id: AtomicU64::new(1),
        }
    }

    fn next_request_id(&self) -> u64 {
        self.request_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn command(&self, command: Value) -> Result<Value, PlaybackError> {
        let endpoint = self
            .session
            .lock()
            .await
            .as_ref()
            .map(|session| session.endpoint.clone())
            .ok_or(PlaybackError::InvalidState)?;
        issue_command(endpoint, command, self.next_request_id()).await
    }

    async fn property(&self, name: &'static str) -> Result<Value, PlaybackError> {
        self.command(json!(["get_property", name])).await
    }
}

#[async_trait]
impl PlaybackEngine for MpvEngine {
    async fn probe(&self) -> Result<String, PlaybackError> {
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(&self.executable).arg("--version").output(),
        )
        .await
        .map_err(|_| PlaybackError::Unavailable)?
        .map_err(|_| PlaybackError::Unavailable)?;
        if !output.status.success() {
            return Err(PlaybackError::Unavailable);
        }
        let first_line = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        let Some(version) = parse_mpv_version(&first_line) else {
            return Err(PlaybackError::Unavailable);
        };
        if version != EXPECTED_MPV_VERSION {
            return Err(PlaybackError::Unavailable);
        }
        Ok(version.to_string())
    }

    async fn open(&self, source: PlaybackSource) -> Result<EngineState, PlaybackError> {
        if !source.canonical_path.is_absolute() || source.start_ms >= source.end_ms {
            return Err(PlaybackError::InvalidState);
        }
        self.close().await?;
        let endpoint = ipc_endpoint();
        let mut child = Command::new(&self.executable)
            .args([
                "--no-config",
                "--idle=yes",
                "--force-window=immediate",
                "--keep-open=yes",
                "--pause=yes",
                "--terminal=no",
                "--input-default-bindings=yes",
                "--osc=yes",
            ])
            .arg(format!("--input-ipc-server={endpoint}"))
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| PlaybackError::StartFailed)?;

        let ready = wait_until_ready(&endpoint, self.next_request_id()).await;
        if ready.is_err() {
            let _ = child.kill().await;
            return Err(PlaybackError::IpcUnavailable);
        }
        let path = source.canonical_path.to_string_lossy().to_string();
        if issue_command(
            endpoint.clone(),
            json!(["loadfile", path, "replace"]),
            self.next_request_id(),
        )
        .await
        .is_err()
        {
            let _ = child.kill().await;
            return Err(PlaybackError::CommandFailed);
        }
        wait_until_file_loaded(&endpoint, self.next_request_id()).await?;
        issue_command(
            endpoint.clone(),
            json!(["seek", millis_to_seconds(source.start_ms), "absolute+exact"]),
            self.next_request_id(),
        )
        .await?;
        *self.session.lock().await = Some(MpvSession { child, endpoint });
        self.state().await
    }

    async fn play(&self) -> Result<(), PlaybackError> {
        self.command(json!(["set_property", "pause", false]))
            .await
            .map(|_| ())
    }

    async fn pause(&self) -> Result<(), PlaybackError> {
        self.command(json!(["set_property", "pause", true]))
            .await
            .map(|_| ())
    }

    async fn seek(&self, position_ms: u64) -> Result<(), PlaybackError> {
        self.command(json!([
            "seek",
            millis_to_seconds(position_ms),
            "absolute+exact"
        ]))
        .await
        .map(|_| ())
    }

    async fn set_speed(&self, multiplier: f64) -> Result<(), PlaybackError> {
        if !(0.5..=2.0).contains(&multiplier) {
            return Err(PlaybackError::InvalidState);
        }
        self.command(json!(["set_property", "speed", multiplier]))
            .await
            .map(|_| ())
    }

    async fn state(&self) -> Result<EngineState, PlaybackError> {
        let position = self
            .property("time-pos")
            .await?
            .as_f64()
            .unwrap_or_default();
        let duration = self
            .property("duration")
            .await?
            .as_f64()
            .unwrap_or_default();
        let paused = self.property("pause").await?.as_bool().unwrap_or(true);
        let speed = self.property("speed").await?.as_f64().unwrap_or(1.0);
        Ok(EngineState {
            position_ms: seconds_to_millis(position),
            duration_ms: seconds_to_millis(duration),
            paused,
            speed,
        })
    }

    async fn close(&self) -> Result<(), PlaybackError> {
        let Some(mut session) = self.session.lock().await.take() else {
            return Ok(());
        };
        let _ = issue_command(
            session.endpoint.clone(),
            json!(["quit"]),
            self.next_request_id(),
        )
        .await;
        if tokio::time::timeout(Duration::from_secs(2), session.child.wait())
            .await
            .is_err()
        {
            let _ = session.child.kill().await;
        }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&session.endpoint);
        Ok(())
    }
}

async fn wait_until_file_loaded(endpoint: &str, request_id: u64) -> Result<(), PlaybackError> {
    for attempt in 0..100_u64 {
        let duration = issue_command(
            endpoint.to_string(),
            json!(["get_property", "duration"]),
            request_id + attempt,
        )
        .await;
        if duration
            .ok()
            .and_then(|value| value.as_f64())
            .is_some_and(|seconds| seconds.is_finite() && seconds > 0.0)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(PlaybackError::CommandFailed)
}

async fn wait_until_ready(endpoint: &str, request_id: u64) -> Result<(), PlaybackError> {
    for attempt in 0..40_u64 {
        if issue_command(
            endpoint.to_string(),
            json!(["get_property", "mpv-version"]),
            request_id + attempt,
        )
        .await
        .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(PlaybackError::IpcUnavailable)
}

async fn issue_command(
    endpoint: String,
    command: Value,
    request_id: u64,
) -> Result<Value, PlaybackError> {
    tokio::task::spawn_blocking(move || transact(&endpoint, command, request_id))
        .await
        .map_err(|_| PlaybackError::IpcUnavailable)?
}

fn transact(endpoint: &str, command: Value, request_id: u64) -> Result<Value, PlaybackError> {
    let request = json!({ "command": command, "request_id": request_id });
    let encoded = serde_json::to_vec(&request).map_err(|_| PlaybackError::CommandFailed)?;

    #[cfg(windows)]
    let stream = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(endpoint)
        .map_err(|_| PlaybackError::IpcUnavailable)?;
    #[cfg(unix)]
    let stream = std::os::unix::net::UnixStream::connect(endpoint)
        .map_err(|_| PlaybackError::IpcUnavailable)?;
    #[cfg(not(any(windows, unix)))]
    return Err(PlaybackError::Unavailable);

    let mut writer = stream
        .try_clone()
        .map_err(|_| PlaybackError::IpcUnavailable)?;
    writer
        .write_all(&encoded)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|_| PlaybackError::IpcUnavailable)?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    for _ in 0..20 {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|_| PlaybackError::IpcUnavailable)?
            == 0
        {
            return Err(PlaybackError::IpcUnavailable);
        }
        let response: Value =
            serde_json::from_str(&line).map_err(|_| PlaybackError::CommandFailed)?;
        if response.get("request_id").and_then(Value::as_u64) != Some(request_id) {
            continue;
        }
        if response.get("error").and_then(Value::as_str) != Some("success") {
            return Err(PlaybackError::CommandFailed);
        }
        return Ok(response.get("data").cloned().unwrap_or(Value::Null));
    }
    Err(PlaybackError::CommandFailed)
}

fn ipc_endpoint() -> String {
    let id = Uuid::new_v4().simple().to_string();
    if cfg!(windows) {
        format!(r"\\.\pipe\lectorbit-mpv-{id}")
    } else {
        std::env::temp_dir()
            .join(format!("lectorbit-mpv-{id}.sock"))
            .to_string_lossy()
            .to_string()
    }
}

fn millis_to_seconds(value: u64) -> f64 {
    value as f64 / 1000.0
}

fn seconds_to_millis(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        0
    } else {
        (value * 1000.0).round().min(u64::MAX as f64) as u64
    }
}

fn parse_mpv_version(banner: &str) -> Option<&str> {
    banner.strip_prefix("mpv v")?.split('-').next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_is_private_and_unique_shaped() {
        let endpoint = ipc_endpoint();
        assert!(endpoint.contains("lectorbit-mpv-"));
    }

    #[test]
    fn time_conversion_is_stable() {
        assert_eq!(seconds_to_millis(millis_to_seconds(90_123)), 90_123);
        assert_eq!(seconds_to_millis(f64::NAN), 0);
    }

    #[test]
    fn pinned_version_is_read_from_release_and_ci_banners() {
        assert_eq!(parse_mpv_version("mpv v0.41.0"), Some("0.41.0"));
        assert_eq!(
            parse_mpv_version("mpv v0.41.0-dev-g41f6a6450"),
            Some("0.41.0")
        );
        assert_eq!(parse_mpv_version("not-mpv 0.41.0"), None);
    }

    #[tokio::test]
    #[ignore = "requires an installed mpv binary and local media fixture"]
    async fn installed_engine_opens_media_over_json_ipc() {
        let executable = std::env::var_os("LECTORBIT_MPV_SMOKE_EXECUTABLE")
            .expect("LECTORBIT_MPV_SMOKE_EXECUTABLE");
        let canonical_path = std::env::var_os("LECTORBIT_MPV_SMOKE_MEDIA")
            .map(PathBuf::from)
            .expect("LECTORBIT_MPV_SMOKE_MEDIA");
        let engine = MpvEngine::new(executable);

        assert_eq!(
            engine.probe().await.expect("probe pinned mpv"),
            EXPECTED_MPV_VERSION
        );
        let state = engine
            .open(PlaybackSource {
                media_id: "smoke-test".into(),
                canonical_path,
                start_ms: 0,
                end_ms: u64::MAX,
            })
            .await
            .expect("open indexed media");
        assert!(state.duration_ms > 0);
        engine.close().await.expect("close mpv session");
    }
}
