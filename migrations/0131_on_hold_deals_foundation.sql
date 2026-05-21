DO $tenant$
DECLARE
  tenant_schema text;
  had_stage_entry_snapshot boolean;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = tenant_schema
         AND table_name = 'deals'
         AND column_name = 'on_hold_accumulated_seconds_at_stage_entry'
    )
      INTO had_stage_entry_snapshot;

    EXECUTE format(
      $sql$
        ALTER TABLE %I.deals
          ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS on_hold_started_at timestamptz,
          ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds_at_stage_entry bigint NOT NULL DEFAULT 0;
      $sql$,
      tenant_schema
    );

    IF NOT had_stage_entry_snapshot THEN
      EXECUTE format(
        $sql$
          UPDATE %I.deals
             SET on_hold_accumulated_seconds_at_stage_entry = on_hold_accumulated_seconds
           WHERE on_hold_accumulated_seconds <> 0;
        $sql$,
        tenant_schema
      );
    END IF;
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS on_hold_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds_at_stage_entry bigint NOT NULL DEFAULT 0;

DO $office_dallas$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'office_dallas'
       AND table_name = 'deals'
       AND column_name = 'on_hold_accumulated_seconds_at_stage_entry'
  ) THEN
    UPDATE office_dallas.deals
       SET on_hold_accumulated_seconds_at_stage_entry = on_hold_accumulated_seconds
     WHERE on_hold_accumulated_seconds <> 0;
  END IF;
END
$office_dallas$;
-- TENANT_SCHEMA_END
