-- Migration 0028: Pipeline workflow alignment foundation
-- Adds lead qualification storage, neutral opportunity routing state,
-- routing history, and department handoff metadata.

DO $$ BEGIN
  CREATE TYPE deal_pipeline_disposition AS ENUM ('opportunity', 'deals', 'service');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE deal_team_role ADD VALUE IF NOT EXISTS 'client_services';
ALTER TYPE deal_team_role ADD VALUE IF NOT EXISTS 'operations';

INSERT INTO public.pipeline_stage_config (
  name,
  slug,
  display_order,
  workflow_family,
  is_active_pipeline,
  is_terminal,
  color
)
VALUES
  ('New', 'lead_new', 1, 'lead', true, false, '#2563EB'),
  ('Company Pre-Qualified', 'company_pre_qualified', 2, 'lead', true, false, '#0EA5E9'),
  ('Scoping In Progress', 'scoping_in_progress', 3, 'lead', true, false, '#8B5CF6'),
  ('Pre-Qual Value Assigned', 'pre_qual_value_assigned', 4, 'lead', true, false, '#14B8A6'),
  ('Lead Go/No-Go', 'lead_go_no_go', 5, 'lead', true, false, '#F59E0B'),
  ('Qualified for Opportunity', 'qualified_for_opportunity', 6, 'lead', true, false, '#22C55E'),
  ('Disqualified', 'lead_disqualified', 99, 'lead', false, true, '#EF4444')
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  display_order = EXCLUDED.display_order,
  workflow_family = EXCLUDED.workflow_family,
  is_active_pipeline = EXCLUDED.is_active_pipeline,
  is_terminal = EXCLUDED.is_terminal,
  color = EXCLUDED.color;

INSERT INTO public.pipeline_stage_config (
  name,
  slug,
  display_order,
  workflow_family,
  is_active_pipeline,
  is_terminal,
  color
)
VALUES
  ('Opportunity', 'opportunity', 1, 'standard_deal', true, false, '#6366F1')
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  display_order = EXCLUDED.display_order,
  workflow_family = EXCLUDED.workflow_family,
  is_active_pipeline = EXCLUDED.is_active_pipeline,
  is_terminal = EXCLUDED.is_terminal,
  color = EXCLUDED.color;

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
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = nspname
          AND table_name = 'leads'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS pipeline_disposition deal_pipeline_disposition NOT NULL DEFAULT ''deals''',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ALTER COLUMN workflow_route DROP NOT NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ALTER COLUMN workflow_route DROP DEFAULT',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.lead_qualification (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         lead_id UUID NOT NULL UNIQUE REFERENCES %I.leads(id),
         estimated_opportunity_value NUMERIC(14,2),
         go_decision VARCHAR(20),
         go_decision_notes TEXT,
         qualification_data JSONB NOT NULL DEFAULT ''{}''::jsonb,
         scoping_subset_data JSONB NOT NULL DEFAULT ''{}''::jsonb,
         disqualification_reason VARCHAR(100),
         disqualification_notes TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_routing_history (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL REFERENCES %I.deals(id),
         from_workflow_route %I.workflow_route,
         to_workflow_route %I.workflow_route NOT NULL,
         value_source VARCHAR(80) NOT NULL,
         triggering_value NUMERIC(14,2) NOT NULL,
         reason TEXT,
         changed_by UUID NOT NULL REFERENCES public.users(id),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_department_handoffs (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL REFERENCES %I.deals(id),
         from_department VARCHAR(40) NOT NULL,
         to_department VARCHAR(40) NOT NULL,
         effective_owner_user_id UUID REFERENCES public.users(id),
         accepted_at TIMESTAMPTZ,
         acceptance_status VARCHAR(20) NOT NULL DEFAULT ''pending'',
         notes TEXT,
         created_by UUID NOT NULL REFERENCES public.users(id),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name
    );
  END LOOP;
END $$;
