-- The stage history trigger creates duplicate rows because stage-change.ts
-- now explicitly inserts history with full override/backward/duration data.
-- Disable the trigger and rely on the application-level insert.

-- Drop for the dallas office schema (existing)
DROP TRIGGER IF EXISTS stage_history_trigger ON office_dallas.deals;

-- Note: For other office schemas, the provisioning runner should exclude this trigger.
-- The function is left in place (harmless) to avoid breaking migrations that reference it.
