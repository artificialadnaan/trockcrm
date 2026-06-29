-- 0171_deal_companycam_projects.sql
-- Make a deal own MANY CompanyCam projects via a join table (a project still belongs to AT MOST one deal).
--
-- Until now the link lived in the scalar `deals.companycam_project_id`, which capped a deal at a single
-- CompanyCam project: the unassigned-feed "Assign to deal" flow rejected a 2nd/3rd project with a 409.
-- `deal_companycam_projects` becomes the single source of truth for deal <-> CompanyCam-project links:
--   * UNIQUE(companycam_project_id) keeps a project 1:1 with a deal (a project can't be split across deals);
--   * a deal can have many rows (1:many).
--
-- The old scalar `deals.companycam_project_id` is KEPT but DEPRECATED — code stops reading/writing it as of
-- this PR; it is dropped in a later migration. We backfill every existing non-null scalar link into the join
-- table so nothing is lost.
--
-- Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable.

-- Pre-flight duplicate guard (FAIL LOUD). The old scalar deals.companycam_project_id had NO unique
-- constraint, so the same CompanyCam project id could sit on two deals. The backfill below uses
-- ON CONFLICT DO NOTHING (needed for idempotent replay), which would SILENTLY DROP one of those links and
-- quietly send that project's future photos to the wrong deal. Scan every office_* schema (skip any without
-- a deals table) for a non-null companycam_project_id shared by more than one deal — using the SAME source
-- predicate as the backfill so we catch exactly the rows it would insert — and RAISE EXCEPTION naming the
-- schema + count if any exist. This stops the deploy so a human resolves the duplicate before any link is
-- lost, instead of discovering missing photos later.
DO $preflight$
DECLARE
  schema_name text;
  dup_count integer;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- Repair drift FIRST: ensure the deprecated scalar column exists on EVERY tenant. office_pwauditoffice
    -- (and any other drifted/legacy tenant) never got companycam_project_id from migration 0007. Without it,
    -- not only does the dup-check below error 42703 — the deployed runtime CompanyCam flows that still mirror
    -- to this column (feed-service assign, link/unlink) would 42703 on that tenant after deploy. ADD it
    -- (nullable, empty) so the column is universal again. The join table remains the source of truth; this
    -- scalar is the deprecated mirror, dropped in a later migration. ADD COLUMN IF NOT EXISTS is idempotent.
    EXECUTE format(
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS companycam_project_id varchar(50)',
      schema_name
    );

    EXECUTE format(
      'SELECT count(*) FROM (
         SELECT companycam_project_id
         FROM %I.deals
         WHERE companycam_project_id IS NOT NULL
         GROUP BY companycam_project_id
         HAVING count(*) > 1
       ) dup',
      schema_name
    ) INTO dup_count;

    IF dup_count > 0 THEN
      RAISE EXCEPTION
        'Migration 0171 aborted: schema % has % companycam_project_id value(s) shared by more than one deal. The join-table backfill would silently drop a link for each duplicate. Resolve these duplicate scalar links (pick the owning deal, clear the other) before deploying.',
        schema_name, dup_count;
    END IF;
  END LOOP;
END $preflight$;

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_companycam_projects (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id uuid NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
         companycam_project_id varchar(50) NOT NULL,
         project_name text,
         created_at timestamptz NOT NULL DEFAULT now(),
         created_by_user_id uuid,
         CONSTRAINT deal_companycam_projects_ccid_key UNIQUE (companycam_project_id)
       )',
      schema_name, schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_companycam_projects_deal_idx ON %I.deal_companycam_projects (deal_id)',
      schema_name
    );

    -- Backfill the deprecated scalar link. The column is guaranteed to exist (repaired above for drifted
    -- tenants), and the pre-flight guard already RAISEd on any cross-deal duplicate, so this is conflict-free
    -- for the dup case; ON CONFLICT DO NOTHING keeps replays idempotent. Drifted tenants just added an empty
    -- column, so they backfill zero rows — the empty join table is correct (new links go straight to it).
    EXECUTE format(
      'INSERT INTO %I.deal_companycam_projects (deal_id, companycam_project_id)
         SELECT id, companycam_project_id FROM %I.deals WHERE companycam_project_id IS NOT NULL
         ON CONFLICT (companycam_project_id) DO NOTHING',
      schema_name, schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS). A
-- freshly provisioned schema has no deals yet, so no backfill is needed here.
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.deal_companycam_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  companycam_project_id varchar(50) NOT NULL,
  project_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  CONSTRAINT deal_companycam_projects_ccid_key UNIQUE (companycam_project_id)
);
CREATE INDEX IF NOT EXISTS deal_companycam_projects_deal_idx ON office_dallas.deal_companycam_projects (deal_id);
-- TENANT_SCHEMA_END
