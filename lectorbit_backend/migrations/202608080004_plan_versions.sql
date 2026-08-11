-- Immutable planner inputs and committed plan snapshots.

ALTER TABLE plans ADD COLUMN active_version_id TEXT;

CREATE TABLE IF NOT EXISTS study_constraint_versions (
    id                         TEXT PRIMARY KEY,
    user_id                    TEXT NOT NULL,
    daily_budget_minutes       INTEGER NOT NULL,
    allowed_weekdays           TEXT NOT NULL,
    preferred_session_minutes  INTEGER NOT NULL,
    max_continuous_minutes     INTEGER NOT NULL,
    minimum_break_minutes      INTEGER NOT NULL,
    playback_speed_milli       INTEGER NOT NULL,
    horizon_days               INTEGER NOT NULL,
    created_at                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_versions (
    id                     TEXT PRIMARY KEY,
    plan_id                TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    constraint_version_id  TEXT NOT NULL REFERENCES study_constraint_versions(id) ON DELETE RESTRICT,
    horizon_start          TEXT NOT NULL,
    horizon_end            TEXT NOT NULL,
    selections_json        TEXT NOT NULL,
    created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_version_days (
    id                    TEXT PRIMARY KEY,
    plan_version_id       TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
    date                  TEXT NOT NULL,
    effective_content_ms  INTEGER NOT NULL,
    break_ms              INTEGER NOT NULL,
    item_count            INTEGER NOT NULL,
    UNIQUE(plan_version_id, date)
);

CREATE TABLE IF NOT EXISTS plan_version_items (
    id                     TEXT PRIMARY KEY,
    plan_version_day_id    TEXT NOT NULL REFERENCES plan_version_days(id) ON DELETE RESTRICT,
    plan_version_id        TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
    media_id               TEXT NOT NULL,
    chunk_id               TEXT NOT NULL,
    sequence               INTEGER NOT NULL,
    raw_start_ms           INTEGER NOT NULL,
    raw_end_ms             INTEGER NOT NULL,
    effective_duration_ms  INTEGER NOT NULL,
    break_after_ms         INTEGER NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(plan_version_id, sequence),
    CHECK(raw_start_ms >= 0),
    CHECK(raw_end_ms > raw_start_ms),
    CHECK(effective_duration_ms > 0),
    CHECK(status IN ('pending', 'in_progress', 'done', 'skipped', 'postponed'))
);

CREATE INDEX IF NOT EXISTS idx_plan_versions_plan_created
    ON plan_versions(plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_version_days_date
    ON plan_version_days(plan_version_id, date);
CREATE INDEX IF NOT EXISTS idx_plan_version_items_day_seq
    ON plan_version_items(plan_version_day_id, sequence);

CREATE TRIGGER IF NOT EXISTS immutable_constraint_versions_update
BEFORE UPDATE ON study_constraint_versions
BEGIN SELECT RAISE(ABORT, 'constraint versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_constraint_versions_delete
BEFORE DELETE ON study_constraint_versions
BEGIN SELECT RAISE(ABORT, 'constraint versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_plan_versions_update
BEFORE UPDATE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_plan_versions_delete
BEFORE DELETE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_plan_days_update
BEFORE UPDATE ON plan_version_days
BEGIN SELECT RAISE(ABORT, 'plan days are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_plan_days_delete
BEFORE DELETE ON plan_version_days
BEGIN SELECT RAISE(ABORT, 'plan days are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_plan_items_update
BEFORE UPDATE ON plan_version_items
BEGIN SELECT RAISE(ABORT, 'plan items are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_plan_items_delete
BEFORE DELETE ON plan_version_items
BEGIN SELECT RAISE(ABORT, 'plan items are immutable'); END;
