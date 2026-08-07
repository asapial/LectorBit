//! Crawling, ffprobe/FFmpeg adapters, media fingerprinting.
//!
//! Safety rules (enforced in adapter impls):
//! - Never accept an arbitrary executable or shell string from the frontend.
//! - Always invoke ffprobe/ffmpeg with a known path and an argument array.
//! - Parse machine-readable JSON only.