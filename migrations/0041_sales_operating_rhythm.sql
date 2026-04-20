DO $$
BEGIN
  CREATE TYPE forecast_window AS ENUM ('30_days', '60_days', '90_days', 'beyond_90', 'uncommitted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE forecast_category AS ENUM ('commit', 'best_case', 'pipeline');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE support_needed_type AS ENUM ('leadership', 'estimating', 'operations', 'executive_team');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'voicemail';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'lunch';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'site_visit';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'proposal_sent';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'redline_review';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'go_no_go';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'follow_up';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'support_request';

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = nspname
          AND table_name = 'deals'
      )
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = schema_name
        AND table_name = 'leads'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.leads
           ADD COLUMN IF NOT EXISTS decision_maker_name varchar(255),
           ADD COLUMN IF NOT EXISTS decision_process text,
           ADD COLUMN IF NOT EXISTS budget_status varchar(100),
           ADD COLUMN IF NOT EXISTS incumbent_vendor varchar(255),
           ADD COLUMN IF NOT EXISTS unit_count integer,
           ADD COLUMN IF NOT EXISTS build_year integer,
           ADD COLUMN IF NOT EXISTS forecast_window forecast_window,
           ADD COLUMN IF NOT EXISTS forecast_category forecast_category,
           ADD COLUMN IF NOT EXISTS forecast_confidence_percent integer,
           ADD COLUMN IF NOT EXISTS forecast_revenue numeric(14,2),
           ADD COLUMN IF NOT EXISTS forecast_gross_profit numeric(14,2),
           ADD COLUMN IF NOT EXISTS forecast_blockers text,
           ADD COLUMN IF NOT EXISTS next_step text,
           ADD COLUMN IF NOT EXISTS next_step_due_at timestamptz,
           ADD COLUMN IF NOT EXISTS next_milestone_at timestamptz,
           ADD COLUMN IF NOT EXISTS support_needed_type support_needed_type,
           ADD COLUMN IF NOT EXISTS support_needed_notes text,
           ADD COLUMN IF NOT EXISTS forecast_updated_at timestamptz,
           ADD COLUMN IF NOT EXISTS forecast_updated_by uuid',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS leads_forecast_window_idx ON %I.leads (forecast_window)',
        schema_name
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS leads_support_needed_type_idx ON %I.leads (support_needed_type)',
        schema_name
      );
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS decision_maker_name varchar(255),
         ADD COLUMN IF NOT EXISTS decision_process text,
         ADD COLUMN IF NOT EXISTS budget_status varchar(100),
         ADD COLUMN IF NOT EXISTS incumbent_vendor varchar(255),
         ADD COLUMN IF NOT EXISTS unit_count integer,
         ADD COLUMN IF NOT EXISTS build_year integer,
         ADD COLUMN IF NOT EXISTS forecast_window forecast_window,
         ADD COLUMN IF NOT EXISTS forecast_category forecast_category,
         ADD COLUMN IF NOT EXISTS forecast_confidence_percent integer,
         ADD COLUMN IF NOT EXISTS forecast_revenue numeric(14,2),
         ADD COLUMN IF NOT EXISTS forecast_gross_profit numeric(14,2),
         ADD COLUMN IF NOT EXISTS forecast_blockers text,
         ADD COLUMN IF NOT EXISTS next_step text,
         ADD COLUMN IF NOT EXISTS next_step_due_at timestamptz,
         ADD COLUMN IF NOT EXISTS next_milestone_at timestamptz,
         ADD COLUMN IF NOT EXISTS support_needed_type support_needed_type,
         ADD COLUMN IF NOT EXISTS support_needed_notes text,
         ADD COLUMN IF NOT EXISTS forecast_updated_at timestamptz,
         ADD COLUMN IF NOT EXISTS forecast_updated_by uuid',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_forecast_window_idx ON %I.deals (forecast_window)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_support_needed_type_idx ON %I.deals (support_needed_type)',
      schema_name
    );

    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = schema_name
        AND table_name = 'activities'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.activities
           ADD COLUMN IF NOT EXISTS next_step text,
           ADD COLUMN IF NOT EXISTS next_step_due_at timestamptz',
        schema_name
      );
    END IF;
  END LOOP;
END $$;
