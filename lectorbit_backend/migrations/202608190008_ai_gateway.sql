-- Safe, content-free provenance for every outbound AI provider attempt.
-- Consent remains append-only in consent_events; this table records operational
-- facts without prompts, transcript text, images, paths, or credentials.

CREATE TABLE IF NOT EXISTS ai_request_events (
    id                  TEXT PRIMARY KEY,
    consent_event_id    TEXT NOT NULL REFERENCES consent_events(id),
    request_id          TEXT NOT NULL,
    provider            TEXT NOT NULL,
    capability          TEXT NOT NULL,
    prompt_id           TEXT NOT NULL,
    prompt_version      TEXT NOT NULL,
    requested_model     TEXT NOT NULL,
    resolved_model      TEXT,
    request_bytes       INTEGER NOT NULL,
    response_bytes      INTEGER,
    duration_ms         INTEGER NOT NULL,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    total_tokens        INTEGER,
    result              TEXT NOT NULL,
    error_kind          TEXT,
    created_at          TEXT NOT NULL,
    CHECK(request_bytes >= 0),
    CHECK(response_bytes IS NULL OR response_bytes >= 0),
    CHECK(duration_ms >= 0),
    CHECK(result IN ('succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_ai_request_events_request
    ON ai_request_events(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_request_events_created
    ON ai_request_events(created_at DESC);
