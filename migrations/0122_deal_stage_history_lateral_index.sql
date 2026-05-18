-- 0122_deal_stage_history_lateral_index.sql
-- Index supporting the LATERAL JOIN in dashboard/service.ts getDownstreamBottlenecks
-- and any other queries that filter deal_stage_history by (deal_id, to_stage_id).

DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        CREATE INDEX IF NOT EXISTS deal_stage_history_deal_id_to_stage_id_created_at_idx
          ON %I.deal_stage_history (deal_id, to_stage_id, created_at DESC);
      $sql$,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
CREATE INDEX IF NOT EXISTS deal_stage_history_deal_id_to_stage_id_created_at_idx
  ON office_dallas.deal_stage_history (deal_id, to_stage_id, created_at DESC);
-- TENANT_SCHEMA_END
