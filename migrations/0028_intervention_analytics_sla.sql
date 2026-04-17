ALTER TABLE ai_disconnect_cases
  ADD COLUMN current_lifecycle_started_at timestamptz,
  ADD COLUMN last_reopened_at timestamptz;

UPDATE ai_disconnect_cases
SET
  current_lifecycle_started_at = COALESCE(first_detected_at, created_at),
  last_reopened_at = NULL;

ALTER TABLE ai_disconnect_cases
  ALTER COLUMN current_lifecycle_started_at SET NOT NULL;
