-- Forward-looking Procore Portfolio stage relay tracking.
-- This intentionally creates new tables and does not touch the legacy
-- tenant projects mirror.

CREATE TABLE IF NOT EXISTS public.portfolio_project_stage_event_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  status text NOT NULL,
  office_id uuid REFERENCES public.offices(id) ON DELETE SET NULL,
  office_slug text,
  procore_company_id text NOT NULL,
  procore_portfolio_project_id text NOT NULL,
  project_number text,
  project_name text,
  previous_stage text,
  current_stage text NOT NULL,
  current_stage_normalized text NOT NULL,
  is_board_relevant boolean NOT NULL DEFAULT false,
  synchub_webhook_log_id text,
  synchub_sync_mapping_id text,
  error_reason text,
  raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_key)
);

CREATE INDEX IF NOT EXISTS portfolio_project_stage_event_receipts_project_idx
  ON public.portfolio_project_stage_event_receipts(procore_portfolio_project_id);

CREATE INDEX IF NOT EXISTS portfolio_project_stage_event_receipts_status_idx
  ON public.portfolio_project_stage_event_receipts(status, received_at);

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
    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.portfolio_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        procore_company_id text NOT NULL,
        procore_project_id text NOT NULL,
        project_number text,
        name text NOT NULL,
        current_stage text NOT NULL,
        current_stage_normalized text NOT NULL,
        current_stage_entered_at timestamptz,
        is_board_relevant boolean NOT NULL DEFAULT false,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_stage_event_key text,
        raw_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (procore_company_id, procore_project_id)
      )
    $sql$, tenant_schema);

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS portfolio_projects_stage_idx ON %I.portfolio_projects(current_stage_normalized, is_board_relevant)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS portfolio_projects_project_number_idx ON %I.portfolio_projects(project_number)',
      tenant_schema
    );

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.portfolio_project_stage_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        portfolio_project_id uuid NOT NULL REFERENCES %I.portfolio_projects(id) ON DELETE CASCADE,
        event_key text NOT NULL,
        previous_stage text,
        previous_stage_normalized text,
        stage text NOT NULL,
        stage_normalized text NOT NULL,
        is_board_relevant boolean NOT NULL DEFAULT false,
        entered_at timestamptz NOT NULL,
        relay_detected_at timestamptz,
        webhook_timestamp timestamptz,
        raw_event jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (event_key)
      )
    $sql$, tenant_schema, tenant_schema);

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS portfolio_project_stage_entries_project_idx ON %I.portfolio_project_stage_entries(portfolio_project_id, entered_at DESC)',
      tenant_schema
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS portfolio_project_stage_entries_event_key_uidx ON %I.portfolio_project_stage_entries(event_key)',
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.portfolio_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procore_company_id text NOT NULL,
  procore_project_id text NOT NULL,
  project_number text,
  name text NOT NULL,
  current_stage text NOT NULL,
  current_stage_normalized text NOT NULL,
  current_stage_entered_at timestamptz,
  is_board_relevant boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_stage_event_key text,
  raw_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (procore_company_id, procore_project_id)
);

CREATE INDEX IF NOT EXISTS portfolio_projects_stage_idx
  ON office_dallas.portfolio_projects(current_stage_normalized, is_board_relevant);

CREATE INDEX IF NOT EXISTS portfolio_projects_project_number_idx
  ON office_dallas.portfolio_projects(project_number);

CREATE TABLE IF NOT EXISTS office_dallas.portfolio_project_stage_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_project_id uuid NOT NULL REFERENCES office_dallas.portfolio_projects(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  previous_stage text,
  previous_stage_normalized text,
  stage text NOT NULL,
  stage_normalized text NOT NULL,
  is_board_relevant boolean NOT NULL DEFAULT false,
  entered_at timestamptz NOT NULL,
  relay_detected_at timestamptz,
  webhook_timestamp timestamptz,
  raw_event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_key)
);

CREATE INDEX IF NOT EXISTS portfolio_project_stage_entries_project_idx
  ON office_dallas.portfolio_project_stage_entries(portfolio_project_id, entered_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS portfolio_project_stage_entries_event_key_uidx
  ON office_dallas.portfolio_project_stage_entries(event_key);
-- TENANT_SCHEMA_END
