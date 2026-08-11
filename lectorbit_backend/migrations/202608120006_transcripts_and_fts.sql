-- Feature 9: verified local models, versioned transcripts, and rebuildable FTS5.

CREATE TABLE IF NOT EXISTS models (
    id                     TEXT PRIMARY KEY,
    version                TEXT NOT NULL,
    provider               TEXT NOT NULL,
    source_url             TEXT NOT NULL,
    expected_size_bytes    INTEGER NOT NULL,
    sha256                 TEXT NOT NULL,
    architecture           TEXT NOT NULL,
    analyzer_compatibility TEXT NOT NULL,
    license                TEXT NOT NULL,
    CHECK(expected_size_bytes > 0),
    CHECK(length(sha256) = 64),
    CHECK(source_url LIKE 'https://%')
);

CREATE TABLE IF NOT EXISTS model_installs (
    model_id          TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
    state             TEXT NOT NULL,
    bytes_downloaded  INTEGER NOT NULL DEFAULT 0,
    installed_path    TEXT,
    verified_at       TEXT,
    last_error        TEXT,
    updated_at        TEXT NOT NULL,
    CHECK(state IN ('available', 'downloading', 'ready', 'failed')),
    CHECK(bytes_downloaded >= 0)
);

CREATE TABLE IF NOT EXISTS transcripts (
    id               TEXT PRIMARY KEY,
    media_id         TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    model_id         TEXT NOT NULL REFERENCES models(id),
    analyzer_version TEXT NOT NULL,
    language         TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    superseded_at    TEXT
);

CREATE TABLE IF NOT EXISTS transcript_segments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    media_id      TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    ordinal       INTEGER NOT NULL,
    start_ms      INTEGER NOT NULL,
    end_ms        INTEGER NOT NULL,
    text          TEXT NOT NULL,
    UNIQUE(transcript_id, ordinal),
    CHECK(ordinal >= 0),
    CHECK(start_ms >= 0),
    CHECK(end_ms > start_ms),
    CHECK(length(trim(text)) > 0)
);

CREATE TABLE IF NOT EXISTS annotations (
    id         TEXT PRIMARY KEY,
    media_id   TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    at_ms      INTEGER NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(at_ms >= 0),
    CHECK(length(trim(text)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_transcripts_media_active
    ON transcripts(media_id, superseded_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_media_time
    ON transcript_segments(media_id, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS idx_annotations_media_time
    ON annotations(media_id, at_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
    media_id UNINDEXED,
    display_name,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    segment_id UNINDEXED,
    transcript_id UNINDEXED,
    media_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS annotation_fts USING fts5(
    annotation_id UNINDEXED,
    media_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media_files BEGIN
    INSERT INTO media_fts(media_id, display_name) VALUES (new.id, new.display_name);
END;
CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE OF display_name ON media_files BEGIN
    DELETE FROM media_fts WHERE media_id = old.id;
    INSERT INTO media_fts(media_id, display_name) VALUES (new.id, new.display_name);
END;
CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media_files BEGIN
    DELETE FROM media_fts WHERE media_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS transcript_fts_insert AFTER INSERT ON transcript_segments BEGIN
    INSERT INTO transcript_fts(segment_id, transcript_id, media_id, text)
    VALUES (new.id, new.transcript_id, new.media_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS transcript_fts_update AFTER UPDATE OF text ON transcript_segments BEGIN
    DELETE FROM transcript_fts WHERE segment_id = old.id;
    INSERT INTO transcript_fts(segment_id, transcript_id, media_id, text)
    VALUES (new.id, new.transcript_id, new.media_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS transcript_fts_delete AFTER DELETE ON transcript_segments BEGIN
    DELETE FROM transcript_fts WHERE segment_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS annotation_fts_insert AFTER INSERT ON annotations BEGIN
    INSERT INTO annotation_fts(annotation_id, media_id, text)
    VALUES (new.id, new.media_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS annotation_fts_update AFTER UPDATE OF text ON annotations BEGIN
    DELETE FROM annotation_fts WHERE annotation_id = old.id;
    INSERT INTO annotation_fts(annotation_id, media_id, text)
    VALUES (new.id, new.media_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS annotation_fts_delete AFTER DELETE ON annotations BEGIN
    DELETE FROM annotation_fts WHERE annotation_id = old.id;
END;

-- Backfill labels that existed before this migration.
INSERT INTO media_fts(media_id, display_name)
SELECT id, display_name FROM media_files
WHERE NOT EXISTS (SELECT 1 FROM media_fts WHERE media_fts.media_id = media_files.id);
