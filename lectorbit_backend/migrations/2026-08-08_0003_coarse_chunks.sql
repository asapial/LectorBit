-- Rebuildable timestamp windows available immediately after ffprobe metadata.

CREATE TABLE IF NOT EXISTS chunks (
    id               TEXT PRIMARY KEY,
    media_id         TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    ordinal          INTEGER NOT NULL,
    start_ms         INTEGER NOT NULL,
    end_ms           INTEGER NOT NULL,
    source           TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    UNIQUE(media_id, source, ordinal),
    CHECK(ordinal >= 0),
    CHECK(start_ms >= 0),
    CHECK(end_ms > start_ms),
    CHECK(source IN ('coarse', 'scene', 'transcript'))
);

CREATE INDEX IF NOT EXISTS idx_chunks_media_range
    ON chunks(media_id, start_ms, end_ms);
