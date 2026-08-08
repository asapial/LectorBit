//! Diagnostics: environment probe used by `app_get_diagnostics`.
//!
//! Aggregates a small, redacted snapshot of the running app for the Settings
//! page and the diagnostics bundle (Feature 14). Anything sensitive (file
//! paths, user content) is run through `lectorbit_db::redact` before it
//! leaves this crate, so the renderer only ever sees `[REDACTED]` instead
//! of, say, `C:\Users\Alice\Videos`.

use std::path::Path;

use chrono::{DateTime, Utc};
use lectorbit_db::{redact, Db};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::warn;

/// Diagnostics payload. All fields are redacted / safe to surface in the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsReport {
    pub generated_at: DateTime<Utc>,
    pub app: AppInfo,
    pub database: DatabaseInfo,
    pub library: LibrarySummary,
    pub ai: AiSummary,
    pub recent_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub version: &'static str,
    pub build: &'static str,
    pub target_triple: &'static str,
    pub elapsed_since_launch: Option<chrono::Duration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub schema_version: u32,
    pub migrations_applied: u32,
    pub sqlite_version: String,
    pub journal_mode: String,
    pub foreign_keys: bool,
    pub size_bytes: Option<u64>,
    pub path_redacted: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibrarySummary {
    pub root_count: i64,
    pub active_root_count: i64,
    pub media_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSummary {
    pub whisper_model_present: bool,
    pub ocr_model_present: bool,
    pub embeddings_model_present: bool,
    pub last_consent: Option<String>,
}

#[derive(Debug, Error)]
pub enum DiagnosticsError {
    #[error("database error: {0}")]
    Database(#[from] lectorbit_db::DbError),
}

/// Service that owns the diagnostics probe. Cheap to construct (just holds a
/// `Db` handle); the actual work happens in `collect`.
#[derive(Debug, Clone)]
pub struct DiagnosticsService {
    db: Db,
    app_version: &'static str,
    app_build: &'static str,
    started_at: DateTime<Utc>,
    whisper_model_present: bool,
    ocr_model_present: bool,
    embeddings_model_present: bool,
}

impl DiagnosticsService {
    pub fn new(
        db: Db,
        app_version: &'static str,
        app_build: &'static str,
        started_at: DateTime<Utc>,
    ) -> Self {
        Self {
            db,
            app_version,
            app_build,
            started_at,
            // Feature 5 will populate these from the actual model registry on
            // disk. Until then, the UI shows "missing" which is the honest
            // answer for a fresh install.
            whisper_model_present: false,
            ocr_model_present: false,
            embeddings_model_present: false,
        }
    }

    /// Override the AI model presence flags. Used by Feature 5 once the
    /// model registry exists; safe to call multiple times.
    pub fn with_ai_presence(
        mut self,
        whisper: bool,
        ocr: bool,
        embeddings: bool,
    ) -> Self {
        self.whisper_model_present = whisper;
        self.ocr_model_present = ocr;
        self.embeddings_model_present = embeddings;
        self
    }

    /// Build the report. Every string is redacted before being returned.
    ///
    /// This function is total: any per-section failure is logged and the
    /// corresponding field gets a `None` / safe default. We never want a
    /// diagnostics call to crash the UI.
    pub async fn collect(&self) -> DiagnosticsReport {
        let generated_at = Utc::now();

        let app = AppInfo {
            version: self.app_version,
            build: self.app_build,
            target_triple: current_target_triple(),
            elapsed_since_launch: Some(generated_at.signed_duration_since(self.started_at)),
        };

        let database = self.collect_database().await;
        let library = self.collect_library().await;
        let ai = self.collect_ai();
        let recent_errors = self.collect_recent_errors().await;

        DiagnosticsReport {
            generated_at,
            app,
            database,
            library,
            ai,
            recent_errors,
        }
    }

    async fn collect_database(&self) -> DatabaseInfo {
        // Schema version lives in `schema_meta` (key = "version"). Default to 0
        // if the row is missing for any reason.
        let schema_version: u32 = sqlx::query_scalar(
            "SELECT value FROM schema_meta WHERE key = 'version'",
        )
        .fetch_optional(self.db.pool())
        .await
        .ok()
        .flatten()
        .and_then(|s: String| s.parse().ok())
        .unwrap_or(0);

        let migrations_applied: u32 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1",
        )
        .fetch_one(self.db.pool())
        .await
        .ok()
        .and_then(|v: i64| u32::try_from(v).ok())
        .unwrap_or(0);

        let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(self.db.pool())
            .await
            .unwrap_or_else(|e| {
                warn!(target: "diagnostics", error = %e, "sqlite_version() failed");
                String::from("unknown")
            });

        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(self.db.pool())
            .await
            .unwrap_or_else(|e| {
                warn!(target: "diagnostics", error = %e, "PRAGMA journal_mode failed");
                String::from("unknown")
            });

        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(self.db.pool())
            .await
            .unwrap_or(0);
        let foreign_keys = foreign_keys != 0;

        let path_redacted = self
            .db
            .path()
            .map(|p| redact_path_for_display(p));

        let size_bytes = self.db.path().and_then(|p| fs_size(p));

        DatabaseInfo {
            schema_version,
            migrations_applied,
            sqlite_version,
            journal_mode,
            foreign_keys,
            size_bytes,
            path_redacted,
        }
    }

    async fn collect_library(&self) -> LibrarySummary {
        let root_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_roots")
            .fetch_one(self.db.pool())
            .await
            .unwrap_or(0);
        let active_root_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM library_roots WHERE revoked_at IS NULL",
        )
        .fetch_one(self.db.pool())
        .await
        .unwrap_or(0);
        let media_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_files")
            .fetch_one(self.db.pool())
            .await
            .unwrap_or(0);

        LibrarySummary {
            root_count,
            active_root_count,
            media_count,
        }
    }

    fn collect_ai(&self) -> AiSummary {
        AiSummary {
            whisper_model_present: self.whisper_model_present,
            ocr_model_present: self.ocr_model_present,
            embeddings_model_present: self.embeddings_model_present,
            last_consent: None, // Feature 5 will populate this.
        }
    }

    async fn collect_recent_errors(&self) -> Vec<String> {
        // audit_events is the safe place to surface — it's already structured
        // and never contains free-form user content.
        let rows: Vec<(String, String)> = match sqlx::query_as(
            "SELECT category, action FROM audit_events \
             WHERE category = 'error' ORDER BY created_at DESC LIMIT 5",
        )
        .fetch_all(self.db.pool())
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                warn!(target: "diagnostics", error = %e, "audit_events query failed");
                return Vec::new();
            }
        };

        rows.into_iter()
            .map(|(category, action)| redact(&format!("{category}: {action}")))
            .collect()
    }
}

/// Render a file path safely for diagnostics output. We never want the
/// original user folder name in the UI, so we redact the path entirely
/// before it leaves the service. The basename is preserved because it's
/// usually non-identifying (e.g. `lectordb.sqlite`).
fn redact_path_for_display(path: &Path) -> String {
    let redacted = redact(&path.display().to_string());
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        // Best-effort: if the basename is itself identifying (e.g. uses the
        // user's first name), drop it too. Otherwise keep it for context.
        let safe_name = if name.chars().any(|c| c.is_ascii_uppercase())
            && name.split_whitespace().count() > 1
        {
            "[REDACTED]".to_string()
        } else {
            name.to_string()
        };
        let prefix = redacted
            .rsplit_once(|c: char| c == '/' || c == '\\')
            .map(|(parent, _)| format!("{parent}/"))
            .unwrap_or_default();
        format!("{prefix}{safe_name}")
    } else {
        redacted
    }
}

/// Best-effort file size lookup. Returns `None` on any I/O error so
/// diagnostics stays a "never panic" function.
fn fs_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).map(|m| m.len()).ok()
}

/// Best-effort target triple. We don't have the full target triple available
/// at runtime (only the arch + OS), but that's enough for a debug pane.
fn current_target_triple() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_path_for_display_keeps_basename() {
        let p = Path::new("C:\\Users\\Alice\\lecture.sqlite");
        let out = redact_path_for_display(p);
        assert!(!out.contains("Alice"));
        assert!(out.ends_with("lecture.sqlite"));
    }

    #[test]
    fn redact_path_for_display_drops_suspicious_basename() {
        // Two-word capitalized basename -> redacted too.
        let p = Path::new("/home/Alice/Project Plan");
        let out = redact_path_for_display(p);
        assert!(!out.contains("Alice"));
        assert!(out.contains("[REDACTED]"));
    }

    #[test]
    fn redact_path_for_display_handles_posix() {
        let p = Path::new("/data/media/lectordb.sqlite");
        let out = redact_path_for_display(p);
        assert!(out.ends_with("lectordb.sqlite"));
    }
}
#[cfg(test)]
mod collect_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn collect_returns_a_well_formed_report_on_a_fresh_db() {
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let svc = DiagnosticsService::new(db, "0.1.0", "test", Utc::now());

        let report = svc.collect().await;

        // App fields
        assert_eq!(report.app.version, "0.1.0");
        assert_eq!(report.app.build, "test");
        assert!(report.app.elapsed_since_launch.is_some());

        // DB fields
        assert_eq!(report.database.schema_version, 0);
        assert_eq!(report.database.migrations_applied, 1);
        assert!(report.database.sqlite_version.starts_with("3."));
        // journal_mode is "memory" for in-memory DBs, not wal; we don't assert a value.
        assert!(report.database.foreign_keys);

        // Library fields
        assert_eq!(report.library.root_count, 0);
        assert_eq!(report.library.active_root_count, 0);
        assert_eq!(report.library.media_count, 0);

        // AI fields start as false (Feature 5 will populate them).
        assert!(!report.ai.whisper_model_present);
        assert!(!report.ai.ocr_model_present);
        assert!(!report.ai.embeddings_model_present);

        // No errors yet.
        assert!(report.recent_errors.is_empty());
    }

    #[tokio::test]
    async fn collect_handles_long_elapsed_sessions() {
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let started = Utc::now() - chrono::Duration::seconds(7_200);
        let svc = DiagnosticsService::new(db, "0.1.0", "test", started);

        let report = svc.collect().await;
        let elapsed = report.app.elapsed_since_launch.expect("elapsed");
        assert!(elapsed.secs >= 7_200);
    }

    #[tokio::test]
    async fn collect_returns_consistent_shape_even_with_uninitialized_partial_state() {
        // Sanity: many awaits -> single report. The spec is "never panic".
        let db = lectorbit_db::Db::open_in_memory().await.expect("db");
        let svc = DiagnosticsService::new(db, "0.1.0", "test", Utc::now());

        for _ in 0..5 {
            let r = svc.collect().await;
            assert_eq!(r.app.version, "0.1.0");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
}
