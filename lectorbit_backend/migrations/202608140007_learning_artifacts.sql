-- Versioned, rebuildable AI learning artifacts. Generated content never
-- overwrites canonical transcripts, plans, progress, or user-authored notes.

CREATE TABLE IF NOT EXISTS learning_artifacts (
    id             TEXT PRIMARY KEY,
    media_id       TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    transcript_id  TEXT REFERENCES transcripts(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    model_id       TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    input_hash     TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    superseded_at  TEXT,
    CHECK(kind IN ('lecture_understanding', 'study_materials', 'ocr_text')),
    CHECK(schema_version > 0),
    CHECK(length(input_hash) = 64),
    CHECK(json_valid(payload_json))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_artifact_active_input
    ON learning_artifacts(media_id, kind, input_hash)
    WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_learning_artifact_active_media
    ON learning_artifacts(media_id, kind, created_at DESC)
    WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS explanation_notes (
    id                 TEXT PRIMARY KEY,
    media_id           TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    transcript_id      TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
    at_ms              INTEGER NOT NULL,
    title              TEXT NOT NULL,
    body_markdown      TEXT NOT NULL,
    evidence_json      TEXT NOT NULL,
    model_id           TEXT NOT NULL,
    prompt_version     TEXT NOT NULL,
    frame_sha256       TEXT,
    created_at         TEXT NOT NULL,
    CHECK(at_ms >= 0),
    CHECK(length(trim(title)) > 0),
    CHECK(length(trim(body_markdown)) > 0),
    CHECK(json_valid(evidence_json)),
    CHECK(frame_sha256 IS NULL OR length(frame_sha256) = 64)
);

CREATE INDEX IF NOT EXISTS idx_explanation_notes_media_time
    ON explanation_notes(media_id, at_ms, created_at DESC);

CREATE TABLE IF NOT EXISTS study_items (
    id               TEXT PRIMARY KEY,
    artifact_id      TEXT NOT NULL REFERENCES learning_artifacts(id) ON DELETE CASCADE,
    media_id         TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    chapter_start_ms INTEGER,
    kind             TEXT NOT NULL,
    prompt           TEXT NOT NULL,
    answer           TEXT NOT NULL,
    hint             TEXT,
    options_json     TEXT,
    evidence_json    TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    CHECK(kind IN ('flashcard', 'multiple_choice', 'short_answer', 'explain_own_words')),
    CHECK(chapter_start_ms IS NULL OR chapter_start_ms >= 0),
    CHECK(options_json IS NULL OR json_valid(options_json)),
    CHECK(json_valid(evidence_json))
);

CREATE INDEX IF NOT EXISTS idx_study_items_media_kind
    ON study_items(media_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS review_states (
    study_item_id  TEXT PRIMARY KEY REFERENCES study_items(id) ON DELETE CASCADE,
    due_at         TEXT NOT NULL,
    interval_days  INTEGER NOT NULL DEFAULT 0,
    repetitions    INTEGER NOT NULL DEFAULT 0,
    ease_milli     INTEGER NOT NULL DEFAULT 2500,
    last_quality   INTEGER,
    updated_at     TEXT NOT NULL,
    CHECK(interval_days >= 0),
    CHECK(repetitions >= 0),
    CHECK(ease_milli BETWEEN 1300 AND 3000),
    CHECK(last_quality IS NULL OR last_quality BETWEEN 0 AND 5)
);

CREATE TABLE IF NOT EXISTS review_attempts (
    id               TEXT PRIMARY KEY,
    study_item_id    TEXT NOT NULL REFERENCES study_items(id) ON DELETE CASCADE,
    quality          INTEGER NOT NULL,
    confidence       INTEGER NOT NULL,
    response_time_ms INTEGER NOT NULL,
    answer_text      TEXT,
    created_at       TEXT NOT NULL,
    CHECK(quality BETWEEN 0 AND 5),
    CHECK(confidence BETWEEN 1 AND 5),
    CHECK(response_time_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_review_attempts_item_created
    ON review_attempts(study_item_id, created_at DESC);
