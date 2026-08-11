-- Feature 5: ffprobe metadata. Append-only after release.
-- Absolute paths stay in Rust-owned columns and never cross IPC.

ALTER TABLE media_files ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE media_files ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'video';
ALTER TABLE media_files ADD COLUMN duration_ms INTEGER;
ALTER TABLE media_files ADD COLUMN container TEXT;
ALTER TABLE media_files ADD COLUMN video_codec TEXT;
ALTER TABLE media_files ADD COLUMN audio_codec TEXT;
ALTER TABLE media_files ADD COLUMN width INTEGER;
ALTER TABLE media_files ADD COLUMN height INTEGER;
ALTER TABLE media_files ADD COLUMN audio_streams INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_files ADD COLUMN subtitle_streams INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_files ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE media_files ADD COLUMN probe_error TEXT;
ALTER TABLE media_files ADD COLUMN probe_version TEXT;
ALTER TABLE media_files ADD COLUMN probed_at TEXT;

ALTER TABLE media_streams ADD COLUMN duration_ms INTEGER;
ALTER TABLE media_streams ADD COLUMN channels INTEGER;
ALTER TABLE media_streams ADD COLUMN sample_rate INTEGER;
ALTER TABLE media_streams ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_media_probe_status
    ON media_files(probe_status, discovered_at);
CREATE INDEX IF NOT EXISTS idx_media_discovered
    ON media_files(discovered_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_payload_status
    ON analysis_jobs(kind, payload, status);
