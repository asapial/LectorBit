//! Shared domain types: IDs, errors, units, traits.
//!
//! This crate owns no I/O and depends on nothing heavier than `serde`/`chrono`/`uuid`,
//! so it stays cheap to compile and easy to import from anywhere.

pub mod error;
pub mod ids;
pub mod planning;
pub mod units;

pub use error::{LectorError, LectorResult};
pub use ids::{JobId, MediaId, PlanId, PlanItemId, RootId, StudyActionId, UserId};
pub use planning::{
    build_plan, derive_coarse_chunks, CoarseChunk, DayLoad, InfeasibilityCode, MediaWork,
    PlanDraft, PlanningChunk, PlanningConstraints, PlanningError, ScheduledItem, UnscheduledWork,
    COARSE_CHUNK_VERSION,
};
pub use units::{Bytes, Milliseconds, Minutes, Seconds};
