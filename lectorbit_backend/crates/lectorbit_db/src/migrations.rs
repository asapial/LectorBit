//! Embedded migrations. Append-only after release.
//!
//! `sqlx::migrate!` is invoked from `pool::Db::migrate` and walks the
//! `lectorbit_backend/migrations` directory at compile time. The directory
//! is declared via the `SQLX_MIGRATIONS_DIR` env var so the macro can find
//! it from inside `crates/lectorbit_db`.
//!
//! To skip the env var and keep the call site ergonomic, we hard-code the
//! path here (`../../migrations` relative to the crate root).

use sqlx::migrate::Migrator;

/// Path to the workspace migrations directory, relative to the crate root.
pub const MIGRATIONS_DIR: &str = "../../migrations";

/// Compile-time embedded migration set used by both startup and diagnostics.
pub static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

pub fn embedded_migration_count() -> u32 {
    u32::try_from(MIGRATOR.migrations.len()).expect("embedded migration count must fit in u32")
}
