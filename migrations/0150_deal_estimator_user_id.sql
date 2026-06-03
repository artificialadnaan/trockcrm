-- Migration 0150: deals.estimator_user_id (resolved Bid Board estimator -> CRM user)
--
-- Adds a nullable FK so the rep/owner filter can match "assigned_rep = X OR estimator = X"
-- (surfacing deals a person ESTIMATED, not just ones they own as the assigned rep).
-- Resolved at ingest from bid_board_estimator via BID_BOARD_ESTIMATOR_USER_MAP and backfilled
-- for existing deals by scripts/backfill-estimator-user-id.ts. Per-tenant, mirroring
-- migration 0128's created_by_user_id pattern (ON DELETE SET NULL is the FK-safety guard).

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.deals
          ADD COLUMN IF NOT EXISTS estimator_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS deals_estimator_user_id_idx
          ON %1$I.deals (estimator_user_id) WHERE estimator_user_id IS NOT NULL;
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;
