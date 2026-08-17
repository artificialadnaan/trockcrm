-- Migration 0223: PROVENANCE for the Bid Board due-date read-back.
--
--   bid_due_date_from_bid_board_at        -- WHEN the sync wrote deals.bid_due_date
--   bid_due_date_bid_board_project_number -- WHICH Bid Board project it wrote it FOR
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
-- WHY THE PROJECT NUMBER, AND NOT JUST A TIMESTAMP
-- The stamp does not vouch for "the sync once wrote this value". It vouches for "the sync wrote this value
-- FOR THE PROJECT THIS DEAL IS CURRENTLY ON". Those differ the moment a deal is detached ("Move back to
-- Opportunity", 0200) and later linked to a genuinely NEW Bid Board project: the link callback clears
-- bid_board_detached_at but PRESERVES bid_board_due_date, bid_due_date and a bare timestamp stamp — so the
-- override would fire again on provenance earned from a project the deal is no longer on, and the
-- detached-deal leak returns through the front door where the detach guard cannot see it.
--
-- Recording the project number the write was made for closes that structurally rather than by remembering
-- to clear a column on every re-link path (0200's own header is a long argument about why ad-hoc clearing
-- is the fragile choice). The detach already NULLs bid_board_project_number, so a stamped deal stops
-- matching the instant it is detached, and a re-link to a different project stays non-matching until a
-- sync writes for the NEW project — at which point the stamp is legitimately re-earned.
--
-- bid_board_project_number, not procore_bid_id: the latter is NULL on a large share of Bid Board-linked
-- prod deals (they were linked without a Procore identity), and a NULL == NULL comparison is not identity.
-- The project number is the matcher's own tier-2 key and is always present on a row the write-through can
-- reach. It is copied FROM the live column in the same UPDATE, so no normalization mismatch is possible.
--
-- Neither stamp is ever cleared — both record historical facts. Currency is the resolver's SEPARATE day
-- check: a later manual edit or a lead-side correction moves the column off the board's day and revokes
-- the override. All three conditions are required precisely because each alone is wrong — the timestamp
-- alone goes stale, the day check alone accepts a coincidence, and neither notices a change of project.
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
           ADD COLUMN IF NOT EXISTS bid_due_date_from_bid_board_at timestamptz,
           ADD COLUMN IF NOT EXISTS bid_due_date_bid_board_project_number text',
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS bid_due_date_from_bid_board_at timestamptz,
  ADD COLUMN IF NOT EXISTS bid_due_date_bid_board_project_number text;
-- TENANT_SCHEMA_END
