ALTER TABLE ai_disconnect_cases
  ADD COLUMN current_lifecycle_started_at timestamptz,
  ADD COLUMN last_reopened_at timestamptz;

UPDATE ai_disconnect_cases
SET current_lifecycle_started_at = COALESCE(resolved_at, first_detected_at, created_at);

ALTER TABLE ai_disconnect_cases
  ALTER COLUMN current_lifecycle_started_at SET NOT NULL;
