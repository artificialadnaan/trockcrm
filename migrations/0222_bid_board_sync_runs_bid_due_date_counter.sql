-- Migration 0222: bid_board_sync_runs.bid_due_date_updated_count — the Bid Board Due Date read-back counter.
--
-- The ingest now copies the export's Due Date onto deals.bid_due_date (behind BID_BOARD_DUE_DATE_READBACK,
-- default OFF). That write is NOT cosmetic: since 2026-07-27 bid_due_date is the auto-park horizon for
-- genuine estimating-stage deals (shared/src/types/deal-hold-risk.ts and its SQL twin holdHorizonDateSql),
-- so a date more than 90 CT-days out zeroes the deal's value on cards, dashboards, at-risk counts and the
-- worker rollups — and a nearer date un-parks a deal a far-out close target had parked. The sync runs on a
-- SCHEDULE, so the operator's only view of "how many deals did this cycle move?" is the run row. Without
-- its own column the answer would have to be reconstructed from deal_history after the fact.
--
-- Only the UPDATED counter is persisted. The two skip counters (bidDueDateSkippedNoValue — a blank export
-- Due Date, which deliberately never clears the CRM value — and bidDueDateSkippedNoChange) stay
-- in-process/logs, matching the estimate writeback, whose skip counters that predate its columns are also
-- unpersisted. A blank/unchanged row is the NORMAL case on almost every sync; a column for it would be
-- noise, whereas "n deals had their bid due date rewritten" is the number that explains a pipeline swing.
--
-- bid_board_sync_runs is a per-tenant office_* table, so this ships both halves of the tenant convention:
-- the DO-loop retro-fits every schema that exists now, and the TENANT_SCHEMA block is what the office
-- provisioner replays for schemas created after this deploy.
--
-- HONEST NOTE on what the tenant block can and cannot deliver here, because the usual "either half alone
-- leaves an office without the column" claim is NOT true for this table: bid_board_sync_runs is created
-- only inside migration 0063's DO-loop and has no TENANT_SCHEMA block of its own, so for a brand-new
-- office the table does not exist at the moment the provisioner replays these blocks and this ALTER would
-- raise `relation does not exist` rather than adding anything. Migration 0200 has the identical latent
-- issue for its own bid_board_sync_runs column, so this is precedent-consistent and deliberately not
-- diverged from here — fixing it belongs with 0063's provisioning gap, not with a counter column. (New-
-- office provisioning is separately known to fail earlier than this, at 0120.) The DO-loop is what
-- actually delivers the column to every office that exists; the block is kept for convention and applies
-- idempotently to office_dallas at migration time.
--
-- The column IS load-bearing for existing offices: with BID_BOARD_DUE_DATE_READBACK on, every ingest run
-- writes it inside the run's transaction, so a missing column would roll back that office's entire sync
-- rather than degrade quietly. The writer references the column only when the flag is on, precisely so a
-- worker deployed ahead of the API (migrations run on API deploy; the worker does not run them) cannot
-- break the sync before the feature is turned on.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS), NOT NULL DEFAULT 0 so existing run rows read as
-- "zero deals moved" rather than NULL, matching skipped_detached_count / applied_backward_count.

-- Existing tenants.
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
    -- A half-provisioned schema (created, tables not yet cloned) must be skipped, not abort the block.
    IF to_regclass(format('%I.bid_board_sync_runs', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.bid_board_sync_runs
           ADD COLUMN IF NOT EXISTS bid_due_date_updated_count INTEGER NOT NULL DEFAULT 0',
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner replays ONLY this block (office_dallas -> new schema) when an office
-- is created after this deploy. Runs idempotently for office_dallas at migration time too (redundant with
-- the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.bid_board_sync_runs
  ADD COLUMN IF NOT EXISTS bid_due_date_updated_count INTEGER NOT NULL DEFAULT 0;
-- TENANT_SCHEMA_END
