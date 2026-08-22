//! Embedded migrations. Append-only after release.
//!
//! `sqlx::migrate!` is invoked from `pool::Db::migrate` and embeds the
//! `lectorbit_backend/migrations` directory at compile time. `build.rs`
//! watches the directory and validates every raw file checksum against
//! `migrations/checksums.sha384`, preventing stale builds and edits to
//! migrations that may already exist in user databases.

use sqlx::migrate::Migrator;

/// Path to the workspace migrations directory, relative to the crate root.
pub const MIGRATIONS_DIR: &str = "../../migrations";

/// Compile-time embedded migration set used by both startup and diagnostics.
pub static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

pub fn embedded_migration_count() -> u32 {
    u32::try_from(MIGRATOR.migrations.len()).expect("embedded migration count must fit in u32")
}
