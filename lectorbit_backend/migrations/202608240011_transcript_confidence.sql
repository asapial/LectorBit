-- Preserve segment-level confidence emitted by whisper.cpp when the selected
-- JSON mode includes token probabilities. Older and manually corrected
-- segments remain explicitly unknown rather than receiving invented scores.

ALTER TABLE transcript_segments
    ADD COLUMN confidence_milli INTEGER
    CHECK(confidence_milli IS NULL OR confidence_milli BETWEEN 0 AND 1000);
