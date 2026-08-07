//! Database error type.
//!
//! Kept separate from `sqlx::Error` so the rest of the workspace never has to
//! import `sqlx` directly. All fallible DB operations return [`DbResult<T>`].

use lectorbit_core::LectorError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite pool error: {0}")]
    Pool(String),

    #[error("sqlite migration error: {0}")]
    Migrate(String),

    #[error("sqlite IO error: {0}")]
    Io(String),

    #[error("sqlite pragma error: {0}")]
    Pragma(String),

    #[error("invalid path: {0}")]
    Path(String),
}

impl From<sqlx::Error> for DbError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::Io(io) => DbError::Io(io.to_string()),
            sqlx::Error::PoolTimedOut
            | sqlx::Error::PoolClosed
            | sqlx::Error::WorkerCrashed => DbError::Pool(err.to_string()),
            other => DbError::Pool(other.to_string()),
        }
    }
}

impl From<DbError> for LectorError {
    fn from(err: DbError) -> Self {
        LectorError::Database(err.to_string())
    }
}

pub type DbResult<T> = Result<T, DbError>;
