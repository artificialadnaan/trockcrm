-- Migration 0222: index activities.performed_by_user_id — the Mine-scope EXISTS the deals board runs
-- twice per stage column.
--
-- 0021_activity_email_attribution_expansion added performed_by_user_id with a FOREIGN KEY and NO index,
-- while indexing four sibling columns in the same statement (company_id, property_id, lead_id, plus the
-- pre-existing deal_id / responsible_user_id pairs). Postgres does not index the referencing side of an
-- FK automatically, so the column has been unindexed ever since.
--
-- What that costs. `scope=mine` is the DEFAULT and is persisted per user, so most /deals/pipeline loads
-- carry buildDealMineVisibilityCondition, whose second OR-arm is
--
--   EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = deals.id AND a.performed_by_user_id = $1)
--
-- With includeDd=true the board answers 12 stage columns and each column issues 2 queries against
-- `deals`, so a single board load can drive that subplan up to 24 times — and with nothing to look
-- performed_by_user_id up by, each is a full scan of the office's activities table (the largest table in
-- the schema; it grows with every logged call, email, note, and status change).
--
-- Shape: (performed_by_user_id, deal_id). The user id LEADS because it is the constant the query binds;
-- deal_id rides along so the semi-join against deals can be answered from the index alone rather than a
-- heap fetch per candidate row. The same index also narrows the LEAD twin of this predicate
-- (buildLeadMineVisibilityCondition, `a.lead_id = leads.id AND a.performed_by_user_id = $1`) to that
-- user's rows — it just re-checks lead_id on the heap, which is why lead_id is not a second index here.
--
-- Partial on `performed_by_user_id IS NOT NULL`: the column is nullable and is null for every activity
-- row created before 0021's backfill and for any source that never attributes an actor, so the partial
-- predicate keeps the index to the rows this predicate can actually match. `performed_by_user_id = $1`
-- implies IS NOT NULL, so the planner still matches the partial index for every query that needs it.
--
-- BUILT CONCURRENTLY FOR EXISTING TENANTS, by the runner, not here. activities is written on the hot
-- path of essentially every CRM action, and a plain CREATE INDEX inside this DO block takes a
-- write-blocking SHARE lock held until the LAST tenant finishes — every activity insert across every
-- office would queue behind it and start failing on the app's 30/45s timeouts. CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block, so
-- server/src/migrations/activities-performed-by-user-index.ts builds each tenant's index first and the
-- loop below no-ops via IF NOT EXISTS. (Same interception as 0138, 0188 and 0221.)
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS activities_performed_by_user_deal_idx ON %I.activities (performed_by_user_id, deal_id) WHERE performed_by_user_id IS NOT NULL',
      schema_name
    );
  END LOOP;
END
$tenant$;

-- New tenants: the office provisioner replays this block, so a schema created after this deploy gets the
-- same index instead of silently falling back to a full scan of its activities table.
-- TENANT_SCHEMA_START
CREATE INDEX IF NOT EXISTS activities_performed_by_user_deal_idx
  ON office_dallas.activities (performed_by_user_id, deal_id)
  WHERE performed_by_user_id IS NOT NULL;
-- TENANT_SCHEMA_END
