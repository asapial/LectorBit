//! Playback engine abstraction. The planner and UI depend on `PlaybackEngine`,
//! not on mpv specifics.

use async_trait::async_trait;
use lectorbit_core::{MediaId, Milliseconds};

#[async_trait]
pub trait PlaybackEngine: Send + Sync {
    async fn open(&self, media: MediaId) -> Result<(), String>;
    async fn play(&self) -> Result<(), String>;
    async fn pause(&self) -> Result<(), String>;
    async fn seek(&self, position: Milliseconds) -> Result<(), String>;
    async fn set_speed(&self, multiplier: f32) -> Result<(), String>;
    async fn current_position(&self) -> Result<Milliseconds, String>;
}