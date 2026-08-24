-- User-owned lifecycle state for generated study material.

ALTER TABLE study_items
    ADD COLUMN archived INTEGER NOT NULL DEFAULT 0
    CHECK(archived IN (0, 1));

ALTER TABLE study_items
    ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0
    CHECK(user_edited IN (0, 1));

ALTER TABLE study_items
    ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_study_items_archive_created
    ON study_items(archived, created_at DESC);
