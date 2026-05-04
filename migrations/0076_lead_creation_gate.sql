-- Migration 0076: lead creation prerequisite gate

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS build_year integer,
  ADD COLUMN IF NOT EXISTS unit_count integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_poc_role') THEN
    CREATE TYPE lead_poc_role AS ENUM (
      'property_manager',
      'construction_manager',
      'director',
      'other'
    );
  END IF;
END $$;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS primary_contact_role lead_poc_role,
  ADD COLUMN IF NOT EXISTS primary_contact_role_other_label text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_budget_status') THEN
    CREATE TYPE lead_budget_status AS ENUM (
      'budgeted_q1',
      'budgeted_q2',
      'budgeted_q3',
      'budgeted_q4',
      'not_budgeted'
    );
  END IF;
END $$;

-- Safe because pre-cutover leads data is demo-only; existing budget values are intentionally not preserved.
UPDATE leads
   SET budget_status = NULL;

ALTER TABLE leads
  ALTER COLUMN budget_status DROP DEFAULT;

ALTER TABLE leads
  ALTER COLUMN budget_status TYPE lead_budget_status
  USING NULL::lead_budget_status;

-- Questionnaire node definitions are global in public.project_type_question_nodes;
-- tenant lead_question_answers reference these public node IDs.
UPDATE public.project_type_question_nodes
   SET is_required = false,
       updated_at = NOW()
 WHERE key = 'number_of_bidders'
   AND project_type_id IS NULL;

UPDATE public.project_type_question_nodes
   SET is_required = false,
       is_active = false,
       updated_at = NOW()
 WHERE key = 'poc'
   AND project_type_id IS NULL;
