-- Procore Portfolio project mirror for CRM Projects tab.
-- Creates tenant-local mirror tables for launch offices.

DO $$
DECLARE
  schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['office_dallas', 'office_atlanta']
  LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', schema_name);

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_deal_id uuid REFERENCES %I.deals(id) ON DELETE SET NULL,
        procore_project_id text NOT NULL,
        procore_company_id text NOT NULL,
        procore_project_number text,
        name text NOT NULL,
        description text,
        address_line_1 text,
        address_line_2 text,
        city text,
        state text,
        postal_code text,
        country text,
        current_phase_id text,
        current_phase_name text,
        current_phase_sort_order integer,
        is_active boolean NOT NULL DEFAULT true,
        start_date date,
        completion_date date,
        projected_finish_date date,
        warranty_end_date date,
        estimated_value numeric(14,2),
        contract_value numeric(14,2),
        actual_cost numeric(14,2),
        project_owner_id text,
        project_owner_name text,
        procore_created_at timestamptz,
        procore_updated_at timestamptz,
        procore_raw_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        last_synced_at timestamptz NOT NULL DEFAULT now(),
        sync_source text NOT NULL DEFAULT 'manual',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$, schema_name, schema_name);

    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS projects_procore_project_id_uidx ON %I.projects (procore_project_id)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS projects_source_deal_idx ON %I.projects (source_deal_id)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS projects_project_number_idx ON %I.projects (procore_project_number)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS projects_phase_idx ON %I.projects (current_phase_id)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS projects_phase_name_idx ON %I.projects (current_phase_name)', schema_name);

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.project_phase_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES %I.projects(id) ON DELETE CASCADE,
        from_phase_id text,
        from_phase_name text,
        to_phase_id text,
        to_phase_name text NOT NULL,
        changed_at timestamptz NOT NULL,
        changed_by_procore_user_id text,
        changed_by_procore_user_name text,
        sync_source text NOT NULL DEFAULT 'manual',
        raw_event jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$, schema_name, schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS project_phase_history_project_idx ON %I.project_phase_history (project_id)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS project_phase_history_changed_at_idx ON %I.project_phase_history (changed_at)', schema_name);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS project_phase_history_initial_unique ON %I.project_phase_history (project_id, to_phase_id, to_phase_name) NULLS NOT DISTINCT WHERE from_phase_id IS NULL AND from_phase_name IS NULL', schema_name);

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.project_team (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES %I.projects(id) ON DELETE CASCADE,
        procore_user_id text,
        procore_user_name text,
        procore_user_email text,
        role_name text,
        is_active boolean NOT NULL DEFAULT true,
        assigned_at timestamptz,
        last_synced_at timestamptz NOT NULL DEFAULT now(),
        raw_role_data jsonb
      )
    $sql$, schema_name, schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS project_team_project_idx ON %I.project_team (project_id)', schema_name);

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.project_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES %I.projects(id) ON DELETE CASCADE,
        procore_document_id text,
        name text NOT NULL,
        file_url text,
        file_size bigint,
        mime_type text,
        folder_path text,
        uploaded_by_procore_user_name text,
        uploaded_at timestamptz,
        last_synced_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$, schema_name, schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS project_documents_project_idx ON %I.project_documents (project_id)', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS project_documents_procore_document_idx ON %I.project_documents (procore_document_id)', schema_name);

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.project_sync_state (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        procore_project_id text NOT NULL,
        last_full_refresh_at timestamptz,
        last_webhook_at timestamptz,
        last_error text,
        consecutive_errors integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$, schema_name);

    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS project_sync_state_procore_project_uidx ON %I.project_sync_state (procore_project_id)', schema_name);
  END LOOP;
END $$;
