-- Lead Due Diligence approvals are tenant-scoped; shared enum type is public.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'lead_due_diligence_approval_status'
  ) THEN
    CREATE TYPE public.lead_due_diligence_approval_status AS ENUM (
      'pending',
      'approved',
      'rejected',
      'superseded'
    );
  END IF;
END $$;

DO $$
DECLARE
  tenant_schema text;
BEGIN
  -- Tenant schemas are provisioned as office_<slug>; keep the loop precise so
  -- this migration does not touch unrelated schemas.
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office\_%' ESCAPE '\'
    ORDER BY schema_name
  LOOP
    IF to_regclass(format('%I.leads', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I.lead_due_diligence_approvals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id uuid NOT NULL REFERENCES %I.leads(id) ON DELETE CASCADE,
        status public.lead_due_diligence_approval_status NOT NULL DEFAULT 'pending',
        approval_token text NOT NULL,
        requested_by uuid NOT NULL REFERENCES public.users(id),
        requested_at timestamptz NOT NULL DEFAULT now(),
        decided_by uuid REFERENCES public.users(id),
        decided_at timestamptz,
        decision_reason text,
        detection_signal jsonb NOT NULL,
        email_sent_at timestamptz,
        email_message_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (lead_id),
        UNIQUE (approval_token)
      )
    $sql$, tenant_schema, tenant_schema);

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.lead_due_diligence_approvals(status, requested_at)',
      'lead_due_diligence_approvals_status_requested_idx',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.lead_due_diligence_approvals(requested_at)',
      'lead_due_diligence_approvals_requested_idx',
      tenant_schema
    );
  END LOOP;
END $$;
