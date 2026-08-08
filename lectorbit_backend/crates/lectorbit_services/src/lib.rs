//! Application use-cases. Each module owns one bounded area and depends on
//! `lectorbit_core`, `lectorbit_db`, and adapters as needed.
//!
//! Splitting rules: only break a module into its own crate if it grows large,
//! needs different platform deps, or materially improves compile/test isolation.

pub mod diagnostics;
pub mod jobs;
pub mod library;
pub mod models;
pub mod planner;
pub mod progress;
pub mod search;
pub mod settings;

pub use diagnostics::{DiagnosticsReport, DiagnosticsService};