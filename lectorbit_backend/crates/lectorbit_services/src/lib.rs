//! Application use-cases for LectorBit's modular monolith.

pub mod diagnostics;
pub mod jobs;
pub mod library;
pub mod models;
pub mod planner;
pub mod progress;
pub mod search;
pub mod settings;

pub use diagnostics::{DiagnosticsReport, DiagnosticsService};
pub use jobs::{
    enqueue, list_by_kind, mark_completed, mark_failed, mark_running, recover_interrupted, Job,
    JobError, JobEvent, JobStatus,
};
pub use library::{
    AuthorizedRoot, LibraryError, LibraryRootView, LibraryService, ScanEnqueue, ScanJobPayload,
};
