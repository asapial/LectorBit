//! SQLx repositories for every table.
//!
//! Each repo owns one table (or one bounded area like `media_files` + its
//! streams + chunks). The service layer never sees raw SQLx.
//!
//! Today only `library_roots` is implemented (Feature 1). The remaining
//! repos — `chunks`, `media`, `transcripts`, `constraints`, `plans`,
//! `consent`, `models` — are added by Features 4–11. Until they exist,
//! the corresponding service modules operate on typed inputs that the
//! Tauri command layer wires up.

pub mod ai_requests;
pub mod analysis;
pub mod annotations;
pub mod chunks;
pub mod learning;
pub mod library_roots;
pub mod media;
pub mod plans;
pub mod study;
