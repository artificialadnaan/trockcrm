-- 0165_photo_phase_categories.sql
-- Add the 6 project-phase photo categories to the per-tenant `photo_category`
-- enum so new TRockCam captures + CRM web tagging can use them.
--
-- New values (offered going forward): estimating, preconstruction, construction,
-- final_completion, punch, issues.
--
-- Legacy values (before, after, progress, site_visit, damage, safety, delivery,
-- other — created in 0077) are intentionally NOT dropped: existing photo rows
-- reference them, and Postgres cannot remove an enum value that is still in use.
-- They simply stop being offered in the UI; historical photos keep their label.
--
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS is idempotent, so this is safe to
-- re-run and a no-op on tenants that already have the values.
DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regtype(format('%I.photo_category', tenant_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''estimating''', tenant_schema);
      EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''preconstruction''', tenant_schema);
      EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''construction''', tenant_schema);
      EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''final_completion''', tenant_schema);
      EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''punch''', tenant_schema);
      EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''issues''', tenant_schema);
    END IF;
  END LOOP;
END $$;
