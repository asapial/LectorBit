use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LectorError {
    #[error("permission denied: {0}")]
    PermissionDenied(String),

    #[error("resource not found: {0}")]
    NotFound(String),

    #[error("invalid request: {0}")]
    Invalid(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("database error: {0}")]
    Database(String),

    #[error("sidecar error: {0}")]
    Sidecar(String),

    #[error("internal error: {0}")]
    Internal(String),
}

pub type LectorResult<T> = Result<T, LectorError>;
