//! Application use-cases for LectorBit's modular monolith.

pub mod diagnostics;
pub mod jobs;
pub mod library;
pub mod media;
pub mod models;
pub mod planner;
pub mod progress;
pub mod search;
pub mod settings;

pub use diagnostics::{DiagnosticsReport, DiagnosticsService};
pub use jobs::{
    enqueue, find_active_by_payload, list_by_kind, mark_completed, mark_failed, mark_running,
    recover_interrupted, Job, JobError, JobEvent, JobStatus,
};
pub use library::{
    AuthorizedRoot, LibraryError, LibraryRootView, LibraryService, ScanEnqueue, ScanJobPayload,
};
pub use media::{AuthorizedMedia, MediaError, MediaService, ProbeEnqueue, ProbeJobPayload};
pub use planner::{
    AlternativePatch, PlanAlternative, PlanPreview, PlanRequest, PlannerCandidate,
    PlannerCandidatePage, PlannerService, PlannerServiceError, PlanningSelection,
};
pub use progress::{
    PlaybackCapability, PlaybackService, PlaybackUpdate, PlaybackView, ProgressError,
};
