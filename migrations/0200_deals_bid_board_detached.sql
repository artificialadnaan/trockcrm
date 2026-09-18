-- Migration 0200: "Move back to Opportunity" — a durable Bid Board DETACH marker on deals.
--
-- WHY A MARKER AND NOT AN IDENTITY WIPE
-- Moving a deal back to Opportunity is useless while the Bid Board still owns it: the next export
-- cycle re-matches the row and re-applies the Bid Board stage (bid-board-sync/service.ts states
-- outright that backward AND terminal-exit moves are APPLIED, not pinned), dragging the deal straight
-- back into estimating/won. The obvious fix — NULL out procore_bid_id / synchub_bid_board_id so the
-- matcher can't find it — is strictly WORSE than doing nothing: the SyncHub `/opportunities` webhook
-- resolves a deal by exactly those two ids and, on a miss, falls through to INSERT INTO deals, so a
-- wiped identity produces a bid-board-owned TWIN of the same project competing for its project_number.
--
-- So identity is PRESERVED (audit trail + webhook idempotency key) and detachment becomes one nullable
-- timestamp that every sync ingress checks. `bid_board_detached_at IS NULL` is a single predicate in a
-- single place per ingress instead of an emergent property of six nulled mirror columns, and it is
-- reversible: the internal-RFP `bid-board-created` callback clears it when the deal is genuinely
-- re-linked to a NEW Bid Board project after a re-trigger.
--
--   bid_board_detached_at     -- when the deal was severed from Bid Board sync (NULL = attached)
--   bid_board_detached_by     -- the admin/director who did it (public.users id; no cross-schema FK,
--                                matching every other user-id column on this table)
--   bid_board_detach_reason   -- the required free-text reason, mirrored onto deal_history
--   bid_board_detached_was_linked -- did the detach sever a REAL Bid Board project? PERSISTED, not
--                                derived: the dialog's "you must delete this project from the Bid Board
--                                yourself" answer counts is_bid_board_owned / bid_board_project_number /
--                                bid_board_linked_at / read_only_synced_at, and the detach CLEARS all
--                                four. 315 of Dallas's 1,294 active deals are Bid Board linked with no
--                                procore/synchub identity at all, so reconstructing the answer after the
--                                fact from the preserved identity columns would drop the standing
--                                "delete the project" reminder on exactly those deals.
--
-- Plus bid_board_sync_runs.skipped_detached_count: a detached row must be counted as a DELIBERATE skip,
-- not as noMatch. Without its own counter every subsequent sync run would report
-- 'completed_with_unmatched' forever and flood unmatched_project_numbers, burying real operator signal.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so it is safe to re-run across offices.

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
    IF to_regclass(format('%I.deals', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals
           ADD COLUMN IF NOT EXISTS bid_board_detached_at timestamptz,
           ADD COLUMN IF NOT EXISTS bid_board_detached_by uuid,
           ADD COLUMN IF NOT EXISTS bid_board_detach_reason text,
           ADD COLUMN IF NOT EXISTS bid_board_detached_was_linked boolean',
        schema_name
      );

      -- Partial index: detached deals are a tiny minority, and the only query that needs them by this
      -- column is the operator "what has been detached?" review. The sync matcher reads the predicate
      -- as an anti-join filter on rows it already located by project number / bid id, so it does not
      -- need (and would not use) an index on the NULL side.
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_bid_board_detached_idx ON %I.deals (bid_board_detached_at) WHERE bid_board_detached_at IS NOT NULL',
        schema_name
      );
    END IF;

    IF to_regclass(format('%I.bid_board_sync_runs', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.bid_board_sync_runs
           ADD COLUMN IF NOT EXISTS skipped_detached_count INTEGER NOT NULL DEFAULT 0',
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner replays ONLY this block (office_dallas -> new schema) when an
-- office is created after this deploy. Omitting it would let a fresh office drift — its deals table
-- would lack the column and every Bid Board sync query would fail on it.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS bid_board_detached_at timestamptz,
  ADD COLUMN IF NOT EXISTS bid_board_detached_by uuid,
  ADD COLUMN IF NOT EXISTS bid_board_detach_reason text,
  ADD COLUMN IF NOT EXISTS bid_board_detached_was_linked boolean;

CREATE INDEX IF NOT EXISTS deals_bid_board_detached_idx
  ON office_dallas.deals (bid_board_detached_at)
  WHERE bid_board_detached_at IS NOT NULL;

ALTER TABLE office_dallas.bid_board_sync_runs
  ADD COLUMN IF NOT EXISTS skipped_detached_count INTEGER NOT NULL DEFAULT 0;
-- TENANT_SCHEMA_END
