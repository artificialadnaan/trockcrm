-- Migration 0028: Sales funnel model alignment lead metadata
-- Adds qualification and director review fields to tenant lead tables.

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
          AND table_name = 'leads'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS qualification_scope varchar(255),
         ADD COLUMN IF NOT EXISTS qualification_budget_amount numeric(12,2),
         ADD COLUMN IF NOT EXISTS qualification_company_fit boolean,
         ADD COLUMN IF NOT EXISTS qualification_completed_at timestamptz,
         ADD COLUMN IF NOT EXISTS director_review_decision varchar(20),
         ADD COLUMN IF NOT EXISTS director_reviewed_at timestamptz,
         ADD COLUMN IF NOT EXISTS director_reviewed_by uuid REFERENCES public.users(id),
         ADD COLUMN IF NOT EXISTS director_review_reason text',
      schema_name
    );
  END LOOP;
END $$;
