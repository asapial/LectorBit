//! Shared domain types: IDs, errors, units, traits.
//!
//! This crate owns no I/O and depends on nothing heavier than `serde`/`chrono`/`uuid`,
//! so it stays cheap to compile and easy to import from anywhere.

pub mod error;
pub mod ids;
pub mod units;

pub use error::{LectorError, LectorResult};
pub use ids::{JobId, MediaId, PlanId, PlanItemId, RootId, StudyActionId, UserId};
pub use units::{Bytes, Milliseconds, Minutes, Seconds};