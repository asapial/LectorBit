//! Deterministic study planner service boundary.
//!
//! The algorithm lives in `lectorbit_core` so it remains pure and cheap to
//! verify. This module is the stable service-layer import used by persistence
//! and the internal Tauri plugin.

pub use lectorbit_core::planning::*;
