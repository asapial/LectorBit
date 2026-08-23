-- Durable, searchable learning-trail state for timestamped questions and takeaways.

ALTER TABLE annotations
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
    CHECK(kind IN ('note', 'question', 'takeaway'));

ALTER TABLE annotations
    ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0
    CHECK(reviewed IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_annotations_media_kind_created
    ON annotations(media_id, kind, created_at DESC);

