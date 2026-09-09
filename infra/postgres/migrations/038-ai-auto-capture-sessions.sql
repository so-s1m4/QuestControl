-- An active capture session can ask the local worker to collect a sparse,
-- reviewable stream of frames.  The operator still verifies every label.
ALTER TABLE ai_capture_sessions
  ADD COLUMN IF NOT EXISTS auto_capture_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE ai_capture_sessions
  ADD COLUMN IF NOT EXISTS capture_interval_sec integer NOT NULL DEFAULT 12
  CHECK (capture_interval_sec BETWEEN 3 AND 3600);
