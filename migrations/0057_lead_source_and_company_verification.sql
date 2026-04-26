-- Migration 0057: canonical lead source fields and company verification state
-- Additive-only: preserves legacy leads.source and adds company-level verification metadata.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_source_category') THEN
    CREATE TYPE lead_source_category AS ENUM (
      'Data Mine',
      'Referral',
      'Existing',
      'Campaign',
      'Trade Show',
      'Sales Prospecting',
      'Other'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_verification_status') THEN
    CREATE TYPE company_verification_status AS ENUM ('pending', 'verified', 'not_required');
  END IF;
END $$;

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.leads ADD COLUMN IF NOT EXISTS source_category lead_source_category', tenant_schema);
      EXECUTE format('ALTER TABLE %I.leads ADD COLUMN IF NOT EXISTS source_detail text', tenant_schema);

      EXECUTE format($sql$
        UPDATE %I.leads
        SET
          source_category = CASE lower(trim(source))
            WHEN lower('Data Mine') THEN 'Data Mine'::lead_source_category
            WHEN lower('Referral') THEN 'Referral'::lead_source_category
            WHEN lower('Existing') THEN 'Existing'::lead_source_category
            WHEN lower('Campaign') THEN 'Campaign'::lead_source_category
            WHEN lower('Trade Show') THEN 'Trade Show'::lead_source_category
            WHEN lower('Sales Prospecting') THEN 'Sales Prospecting'::lead_source_category
            WHEN lower('Other') THEN 'Other'::lead_source_category
            ELSE 'Other'::lead_source_category
          END,
          source_detail = CASE
            WHEN source IS NULL OR trim(source) = '' THEN source_detail
            WHEN lower(trim(source)) IN (
              lower('Data Mine'),
              lower('Referral'),
              lower('Existing'),
              lower('Campaign'),
              lower('Trade Show'),
              lower('Sales Prospecting'),
              lower('Other')
            ) THEN source_detail
            ELSE COALESCE(source_detail, source)
          END
        WHERE source_category IS NULL
          AND source IS NOT NULL
          AND trim(source) <> ''
      $sql$, tenant_schema);
    END IF;

    IF to_regclass(format('%I.companies', tenant_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS company_verification_status company_verification_status', tenant_schema);
      EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS company_verification_requested_at timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS company_verification_email_sent_at timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS company_verified_at timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS company_verified_by uuid', tenant_schema);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.companies (company_verification_status)', tenant_schema || '_companies_verification_status_idx', tenant_schema);
    END IF;

    IF to_regclass(format('%I.lead_question_answers', tenant_schema)) IS NOT NULL THEN
      EXECUTE format($sql$
        UPDATE %I.lead_question_answers AS answers
        SET value_json = CASE answers.value_json::text
          WHEN '"true"' THEN 'true'::jsonb
          WHEN '"false"' THEN 'false'::jsonb
          ELSE answers.value_json
        END
        FROM public.project_type_question_nodes AS nodes
        WHERE nodes.id = answers.question_id
          AND nodes.input_type = 'boolean'
          AND jsonb_typeof(answers.value_json) = 'string'
          AND answers.value_json::text IN ('"true"', '"false"')
      $sql$, tenant_schema);
    END IF;
  END LOOP;
END $$;
