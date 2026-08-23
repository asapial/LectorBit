//! SQLx repositories, migrations, transactions, FTS5 (planned).
//!
//! Feature 1 ships:
//! - [`Db`] — a small wrapper around `sqlx::SqlitePool` that opens a file DB,
//!   applies WAL/synchronous/foreign_keys/busy_timeout/temp_store PRAGMAs, and
//!   runs the embedded migrations before any other crate can touch the pool.
//! - [`redaction`] — a `MakeWriter` for `tracing_subscriber::fmt::Layer` that
//!   masks file paths, bearer tokens, and emails in every log line.
//!
//! Later features (3, 4, 11, 14) will add SQLx repositories and FTS5 virtual
//! tables on top of this foundation.

#![deny(unsafe_code)]
#![warn(rust_2018_idioms)]

pub mod error;
pub mod migrations;
pub mod pool;
pub mod redaction;
pub mod repo;

pub use error::{DbError, DbResult};
pub use pool::Db;
pub use redaction::{redact, redact_event_fields, RedactingMakeWriter};
pub use repo::ai_requests::{AiRequestProvenance, CloudConsentSummary, Repo as AiRequestsRepo};
pub use repo::analysis::{
    ModelInstallRow, ModelManifestRow, Repo as AnalysisRepo, SearchRow, TranscriptSegmentInput,
    TranscriptStateRow,
};
pub use repo::annotations::{AnnotationRow, Repo as AnnotationsRepo};
pub use repo::chunks::{
    PlannerCandidatePage, PlannerCandidateRow, Repo as ChunksRepo, SchedulableMedia, StoredChunk,
};
pub use repo::learning::{
    ExplanationNoteRow, LearningArtifactRow, Repo as LearningRepo, ReviewStateRow, StudyItemInput,
    StudyItemRow, TranscriptContextRow, TranscriptEvidenceRow,
};
pub use repo::library_roots::{InsertOutcome, LibraryRoot, Repo as LibraryRootsRepo};
pub use repo::media::{
    DiscoveredMedia, MediaListItem, MediaPage, MediaSummary, ProbeCandidate, ProbeTarget,
    Repo as MediaRepo, StoredProbe, StoredStream,
};
pub use repo::plans::{
    ActivePlanSeed, CommittedPlan, Repo as PlansRepo, RoutineDay, RoutineItem, RoutinePlan,
};
pub use repo::study::{
    CheckpointResult, PlaybackItem, ProgressSnapshot, ReplanMediaState, Repo as StudyRepo,
    StudyActionKind, COMPLETION_PERCENT,
};

pub async fn placeholder() {}
