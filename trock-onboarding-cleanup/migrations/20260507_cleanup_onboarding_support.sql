-- Cleanup onboarding support for the temporary T Rock Onboarding Cleanup service.
-- Generated for review only. Do not run until Takashi's cleanup policy answers
-- and the import/schema plan are approved.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_completed_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS onboarding_override_reason text;

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office\_%' ESCAPE '\'
    ORDER BY schemata.schema_name
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals
           ADD COLUMN IF NOT EXISTS cleanup_status varchar(32) DEFAULT ''pending'',
           ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz,
           ADD COLUMN IF NOT EXISTS cleanup_completed_by uuid,
           ADD COLUMN IF NOT EXISTS skip_reason varchar(100),
           ADD COLUMN IF NOT EXISTS skip_notes text,
           ADD COLUMN IF NOT EXISTS needs_leadership_review boolean DEFAULT false,
           ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb DEFAULT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.leads
           ADD COLUMN IF NOT EXISTS cleanup_status varchar(32) DEFAULT ''pending'',
           ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz,
           ADD COLUMN IF NOT EXISTS cleanup_completed_by uuid,
           ADD COLUMN IF NOT EXISTS skip_reason varchar(100),
           ADD COLUMN IF NOT EXISTS skip_notes text,
           ADD COLUMN IF NOT EXISTS needs_leadership_review boolean DEFAULT false,
           ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb DEFAULT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.contacts', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.contacts
           ADD COLUMN IF NOT EXISTS cleanup_status varchar(32) DEFAULT ''pending'',
           ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz,
           ADD COLUMN IF NOT EXISTS cleanup_completed_by uuid,
           ADD COLUMN IF NOT EXISTS skip_reason varchar(100),
           ADD COLUMN IF NOT EXISTS skip_notes text,
           ADD COLUMN IF NOT EXISTS needs_leadership_review boolean DEFAULT false,
           ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb DEFAULT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.companies', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.companies
           ADD COLUMN IF NOT EXISTS cleanup_status varchar(32) DEFAULT ''pending'',
           ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz,
           ADD COLUMN IF NOT EXISTS cleanup_completed_by uuid,
           ADD COLUMN IF NOT EXISTS skip_reason varchar(100),
           ADD COLUMN IF NOT EXISTS skip_notes text,
           ADD COLUMN IF NOT EXISTS needs_leadership_review boolean DEFAULT false,
           ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb DEFAULT NULL',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.activities', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.activities
           ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb DEFAULT NULL',
        tenant_schema
      );
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.cleanup_skips (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         record_type varchar(50) NOT NULL,
         record_id uuid NOT NULL,
         skipped_by uuid NOT NULL REFERENCES public.users(id),
         skip_reason varchar(100) NOT NULL,
         skip_notes text,
         missing_fields jsonb NOT NULL DEFAULT ''[]''::jsonb,
         original_snapshot jsonb,
         reviewed_at timestamptz,
         reviewed_by uuid REFERENCES public.users(id),
         review_outcome varchar(50),
         created_at timestamptz NOT NULL DEFAULT now()
       )',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS cleanup_skips_record_idx
         ON %I.cleanup_skips (record_type, record_id)',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS cleanup_skips_skipped_by_idx
         ON %I.cleanup_skips (skipped_by, created_at DESC)',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS cleanup_skips_review_idx
         ON %I.cleanup_skips (reviewed_at, skip_reason)',
      tenant_schema
    );

    -- Conditional table for Takashi Q5: use only if contacts/companies need
    -- temporary cleanup ownership without adding permanent owner columns.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.cleanup_assignments (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         record_type varchar(50) NOT NULL,
         record_id uuid NOT NULL,
         assigned_to uuid REFERENCES public.users(id),
         assignment_reason varchar(100) NOT NULL,
         source_hubspot_owner_id varchar(64),
         source_hubspot_owner_email varchar(320),
         status varchar(32) NOT NULL DEFAULT ''pending'',
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )',
      tenant_schema
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS cleanup_assignments_record_uidx
         ON %I.cleanup_assignments (record_type, record_id)',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS cleanup_assignments_assignee_status_idx
         ON %I.cleanup_assignments (assigned_to, status)',
      tenant_schema
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS cleanup_assignments_source_owner_idx
         ON %I.cleanup_assignments (source_hubspot_owner_id)',
      tenant_schema
    );
  END LOOP;
END $$;
