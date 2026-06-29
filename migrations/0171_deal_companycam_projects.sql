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
         deal_id uuid NOT NULL REFERENCES %I.deals(id),
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

    -- Backfill the deprecated scalar link. ON CONFLICT DO NOTHING is safe for a clean source (a project is
    -- 1:1 with a deal), but it would SILENTLY drop a row if the same companycam_project_id is on two deals —
    -- run the pre-deploy duplicate census before deploying (see PR notes).
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
  deal_id uuid NOT NULL REFERENCES office_dallas.deals(id),
  companycam_project_id varchar(50) NOT NULL,
  project_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  CONSTRAINT deal_companycam_projects_ccid_key UNIQUE (companycam_project_id)
);
CREATE INDEX IF NOT EXISTS deal_companycam_projects_deal_idx ON office_dallas.deal_companycam_projects (deal_id);
-- TENANT_SCHEMA_END
