ALTER TABLE ai_disconnect_cases
  ADD COLUMN current_lifecycle_started_at timestamptz,
  ADD COLUMN last_reopened_at timestamptz;

UPDATE ai_disconnect_cases
SET
  current_lifecycle_started_at = CASE
    WHEN reopen_count > 0 AND status = 'open'
      THEN COALESCE(last_intervened_at, last_detected_at, updated_at, first_detected_at, created_at)
    ELSE COALESCE(resolved_at, first_detected_at, created_at)
  END,
  last_reopened_at = CASE
    WHEN reopen_count > 0
      THEN COALESCE(last_intervened_at, last_detected_at, updated_at, first_detected_at, created_at)
    ELSE NULL
  END;

ALTER TABLE ai_disconnect_cases
  ALTER COLUMN current_lifecycle_started_at SET NOT NULL;
