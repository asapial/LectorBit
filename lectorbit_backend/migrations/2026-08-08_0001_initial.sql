-- Initial schema. Append-only after release.
-- See project-docs/TECHNOLOGY_BASELINE_2026-08.md and the plan §9 for the
-- audit-frozen table list.

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_roots (
    id              TEXT PRIMARY KEY,         -- UUID v4 as text
    display_name    TEXT NOT NULL,
    canonical_path  TEXT NOT NULL UNIQUE,
    registered_at   TEXT NOT NULL,            -- RFC3339
    revoked_at      TEXT
);

CREATE TABLE IF NOT EXISTS folders (
    id        TEXT PRIMARY KEY,
    root_id   TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    path      TEXT NOT NULL,
    UNIQUE(root_id, path)
);

CREATE TABLE IF NOT EXISTS media_files (
    id          TEXT PRIMARY KEY,
    root_id     TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
    path        TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    mtime       TEXT NOT NULL,
    discovered_at TEXT NOT NULL,
    UNIQUE(root_id, path)
);

CREATE TABLE IF NOT EXISTS media_streams (
    media_id  TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,
    kind      TEXT NOT NULL,   -- video | audio | subtitle | data
    codec     TEXT,
    language  TEXT,
    width     INTEGER,
    height    INTEGER,
    bitrate   INTEGER,
    PRIMARY KEY (media_id, idx)
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,          -- scan | probe | transcribe | model_download
    payload     TEXT NOT NULL,          -- JSON
    status      TEXT NOT NULL,          -- queued | running | succeeded | failed | cancelled
    attempt     INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_constraints (
    user_id            TEXT PRIMARY KEY,
    daily_minutes      INTEGER NOT NULL,
    allowed_weekdays   TEXT NOT NULL,    -- JSON array of 0..6
    max_continuous_min  INTEGER NOT NULL,
    catch_up_mode       INTEGER NOT NULL, -- 0/1
    playback_speed     REAL    NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    archived_at TEXT
);

CREATE TABLE IF NOT EXISTS plan_days (
    id      TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,                -- YYYY-MM-DD
    UNIQUE(plan_id, date)
);

CREATE TABLE IF NOT EXISTS plan_items (
    id           TEXT PRIMARY KEY,
    plan_day_id  TEXT NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
    media_id     TEXT NOT NULL REFERENCES media_files(id),
    chunk_index  INTEGER NOT NULL,
    start_ms     INTEGER NOT NULL,
    end_ms       INTEGER NOT NULL,
    status       TEXT NOT NULL            -- pending | in_progress | done | skipped
);

CREATE TABLE IF NOT EXISTS playback_progress (
    media_id        TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,
    position_ms     INTEGER NOT NULL,
    duration_ms     INTEGER NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_actions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    plan_item_id TEXT REFERENCES plan_items(id) ON DELETE SET NULL,
    media_id    TEXT REFERENCES media_files(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,            -- started | paused | finished | skipped
    payload     TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_events (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    scope      TEXT NOT NULL,             -- cloud | analytics | model_download | ...
    granted    INTEGER NOT NULL,          -- 0/1
    payload    TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    id         TEXT PRIMARY KEY,
    user_id    TEXT,
    category   TEXT NOT NULL,
    action     TEXT NOT NULL,
    payload    TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_root        ON media_files(root_id);
CREATE INDEX IF NOT EXISTS idx_media_folder      ON media_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status       ON analysis_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_plan_items_day    ON plan_items(plan_day_id);
CREATE INDEX IF NOT EXISTS idx_study_actions_u   ON study_actions(user_id, created_at);
