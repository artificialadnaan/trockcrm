-- Migration 0223: deals.bid_due_date_from_bid_board_at — PROVENANCE for the Bid Board due-date read-back.
--
-- WHY A COLUMN AND NOT A COMPARISON
-- The read resolver needs to know one thing: did the Bid Board sync put the value that is currently in
-- `deals.bid_due_date` there? The first design inferred that by comparing the column's UTC day against
-- `deals.bid_board_due_date` — but that mirror has been populated on prod for months, so the comparison
-- also answers TRUE for any deal whose pre-existing bid due date merely COINCIDES with the board's day.
-- For a lead-backed deal that would fire the override the instant BID_BOARD_DUE_DATE_READBACK is flipped,
-- with no sync having run: the displayed date changes, and in a genuine estimating stage the hold verdict
-- and the deal's reported value can change with it. That directly contradicts the property the flag exists
-- to guarantee — flipping it changes nothing until a sync actually writes — and it is exactly the
-- surprise the census is supposed to have measured beforehand. A coincidence is not provenance.
--
-- So the sync stamps this column at the moment it writes `bid_due_date`, and the resolver requires the
-- stamp. At flip time no deal carries one, so the override fires for NOBODY until a sync writes; from then
-- on it fires only for deals the sync actually touched, which is precisely the population the census
-- counts.
--
-- The stamp is a historical fact ("the Bid Board sync wrote this column at time T") and is deliberately
-- never cleared. Currency is handled by the resolver's SEPARATE day check: a later manual edit or a
-- lead-side correction moves the column off the board's day and revokes the override, rather than leaving
-- it stuck on forever. Both conditions are required precisely because each one alone is wrong — the stamp
-- alone goes stale, the day check alone accepts a coincidence.
--
-- timestamptz, not boolean: "when" answers "did this predate the operator's flag flip / the backfill?"
-- during an incident, which a flag cannot. Nullable with no default and no backfill — a NULL means "this
-- value did not come from the Bid Board", which is the correct and conservative reading of every row that
-- exists today.
--
-- deals is a per-tenant office_* table, so this needs BOTH halves: the DO-loop retro-fits every schema that
-- exists now, and the TENANT_SCHEMA block is what the office provisioner replays for schemas created after
-- this deploy. (Unlike bid_board_sync_runs in 0222, `deals` IS created inside the provisioner's replayed
-- block, so both halves genuinely apply here.) Either half alone leaves some office without the column,
-- and with the flag on the ingest writes it on every due-date write.

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
    IF to_regclass(format('%I.deals', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals
           ADD COLUMN IF NOT EXISTS bid_due_date_from_bid_board_at timestamptz',
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS bid_due_date_from_bid_board_at timestamptz;
-- TENANT_SCHEMA_END
