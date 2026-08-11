-- Durable watched coverage and append-only study actions.

ALTER TABLE playback_progress ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS playback_coverage_ranges (
    id          TEXT PRIMARY KEY,
    media_id    TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    start_ms    INTEGER NOT NULL,
    end_ms      INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    CHECK(start_ms >= 0),
    CHECK(end_ms > start_ms)
);

ALTER TABLE study_actions ADD COLUMN plan_version_item_id TEXT
    REFERENCES plan_version_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_playback_coverage_media_range
    ON playback_coverage_ranges(media_id, start_ms, end_ms);
CREATE INDEX IF NOT EXISTS idx_study_actions_version_item_created
    ON study_actions(plan_version_item_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS append_only_study_actions_update
BEFORE UPDATE ON study_actions
BEGIN SELECT RAISE(ABORT, 'study actions are append-only'); END;

CREATE TRIGGER IF NOT EXISTS append_only_study_actions_delete
BEFORE DELETE ON study_actions
BEGIN SELECT RAISE(ABORT, 'study actions are append-only'); END;
