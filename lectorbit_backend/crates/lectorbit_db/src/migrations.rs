//! Embedded migrations. Append-only after release.
//!
//! `sqlx::migrate!` is invoked from `pool::Db::migrate` and walks the
//! `lectorbit_backend/migrations` directory at compile time. The directory
//! is declared via the `SQLX_MIGRATIONS_DIR` env var so the macro can find
//! it from inside `crates/lectorbit_db`.
//!
//! To skip the env var and keep the call site ergonomic, we hard-code the
//! path here (`../../migrations` relative to the crate root).

/// Path to the workspace migrations directory, relative to the crate root.
pub const MIGRATIONS_DIR: &str = "../../migrations";
