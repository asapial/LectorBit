//! Signed updater adapter exposed only through LectorBit's internal plugin.

use std::sync::Arc;

use tauri::{AppHandle, Runtime, Url};
use tauri_plugin_lectorbit::{
    BoxFuture, UpdateCheckDto, UpdateErrorCode, UpdateErrorKind, UpdateEventSink, UpdateOps,
    UpdateProgressDto,
};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

const UPDATE_ENDPOINT: Option<&str> = option_env!("LECTORBIT_UPDATER_ENDPOINT");
const UPDATE_PUBKEY: Option<&str> = option_env!("LECTORBIT_UPDATER_PUBKEY");

pub struct UpdateAdapter<R: Runtime> {
    app: AppHandle<R>,
    install_lock: Mutex<()>,
}

impl<R: Runtime> UpdateAdapter<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            install_lock: Mutex::new(()),
        }
    }

    fn configuration(&self) -> Result<(Url, &'static str), UpdateErrorCode> {
        let endpoint = UPDATE_ENDPOINT
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(not_configured)?;
        let pubkey = UPDATE_PUBKEY
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(not_configured)?;
        let endpoint = Url::parse(endpoint).map_err(|_| not_configured())?;
        if endpoint.scheme() != "https" {
            return Err(not_configured());
        }
        Ok((endpoint, pubkey))
    }

    async fn find_update(&self) -> Result<Option<tauri_plugin_updater::Update>, UpdateErrorCode> {
        let (endpoint, pubkey) = self.configuration()?;
        let updater = self
            .app
            .updater_builder()
            .pubkey(pubkey)
            .endpoints(vec![endpoint])
            .and_then(|builder| builder.build())
            .map_err(|error| {
                tracing::warn!(target: "updater", %error, "updater configuration rejected");
                UpdateErrorCode::new(
                    UpdateErrorKind::Internal,
                    "The signed update service could not be initialized.",
                )
            })?;
        updater.check().await.map_err(|error| {
            let kind = if error.to_string().to_ascii_lowercase().contains("signature") {
                UpdateErrorKind::Verification
            } else {
                UpdateErrorKind::Network
            };
            tracing::warn!(target: "updater", %error, "signed update check failed");
            UpdateErrorCode::new(kind, safe_update_message(kind))
        })
    }

    fn disabled_view(&self) -> UpdateCheckDto {
        UpdateCheckDto {
            status: "disabled".into(),
            current_version: self.app.package_info().version.to_string(),
            version: None,
            notes: None,
            published_at: None,
            target: None,
        }
    }
}

impl<R: Runtime> UpdateOps for UpdateAdapter<R> {
    fn check(&self) -> BoxFuture<'_, Result<UpdateCheckDto, UpdateErrorCode>> {
        Box::pin(async move {
            if self.configuration().is_err() {
                return Ok(self.disabled_view());
            }
            let current_version = self.app.package_info().version.to_string();
            let Some(update) = self.find_update().await? else {
                return Ok(UpdateCheckDto {
                    status: "current".into(),
                    current_version,
                    version: None,
                    notes: None,
                    published_at: None,
                    target: None,
                });
            };
            Ok(UpdateCheckDto {
                status: "available".into(),
                current_version,
                version: Some(update.version.clone()),
                notes: update.body.as_deref().map(safe_notes),
                published_at: update.date.map(|date| date.to_string()),
                target: Some(update.target.clone()),
            })
        })
    }

    fn install(
        &self,
        version: String,
        sink: UpdateEventSink,
    ) -> BoxFuture<'_, Result<(), UpdateErrorCode>> {
        Box::pin(async move {
            if !valid_version_request(&version) {
                return Err(UpdateErrorCode::new(
                    UpdateErrorKind::InvalidRequest,
                    "The selected update is no longer valid. Check again.",
                ));
            }
            let _guard = self.install_lock.try_lock().map_err(|_| {
                UpdateErrorCode::new(
                    UpdateErrorKind::Busy,
                    "Another update installation is already running.",
                )
            })?;
            let update = self.find_update().await?.ok_or_else(|| {
                UpdateErrorCode::new(
                    UpdateErrorKind::InvalidRequest,
                    "LectorBit is already up to date.",
                )
            })?;
            if update.version != version {
                return Err(UpdateErrorCode::new(
                    UpdateErrorKind::InvalidRequest,
                    "A newer update is available. Check again before installing.",
                ));
            }

            let download_sink = Arc::clone(&sink);
            let install_sink = Arc::clone(&sink);
            let mut downloaded_bytes = 0_u64;
            update
                .download_and_install(
                    move |chunk_bytes, total_bytes| {
                        downloaded_bytes = downloaded_bytes.saturating_add(chunk_bytes as u64);
                        download_sink(UpdateProgressDto::Downloading {
                            downloaded_bytes,
                            total_bytes,
                        });
                    },
                    move || install_sink(UpdateProgressDto::Installing),
                )
                .await
                .map_err(|error| {
                    let text = error.to_string().to_ascii_lowercase();
                    let kind = if text.contains("signature") || text.contains("verify") {
                        UpdateErrorKind::Verification
                    } else {
                        UpdateErrorKind::Install
                    };
                    tracing::warn!(target: "updater", %error, "signed update install failed");
                    UpdateErrorCode::new(kind, safe_update_message(kind))
                })?;

            sink(UpdateProgressDto::Relaunching);
            self.app.restart();
        })
    }
}

fn not_configured() -> UpdateErrorCode {
    UpdateErrorCode::new(
        UpdateErrorKind::NotConfigured,
        "Signed updates are not configured for this development build.",
    )
}

fn safe_update_message(kind: UpdateErrorKind) -> &'static str {
    match kind {
        UpdateErrorKind::Network => "The update service could not be reached. Try again later.",
        UpdateErrorKind::Verification => {
            "The update signature could not be verified. Nothing was installed."
        }
        UpdateErrorKind::Install => "The verified update could not be installed.",
        _ => "The update operation could not continue.",
    }
}

fn valid_version_request(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        })
}

fn safe_notes(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(2_000)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_requests_are_strict_and_bounded() {
        assert!(valid_version_request("1.2.3-beta.1+build"));
        assert!(!valid_version_request("../1.2.3"));
        assert!(!valid_version_request("1.2.3 latest"));
        assert!(!valid_version_request(&"a".repeat(65)));
    }

    #[test]
    fn remote_notes_are_bounded_and_strip_control_characters() {
        let notes = format!("safe\0{}", "x".repeat(2_100));
        let safe = safe_notes(&notes);
        assert!(!safe.contains('\0'));
        assert_eq!(safe.chars().count(), 2_000);
    }
}
