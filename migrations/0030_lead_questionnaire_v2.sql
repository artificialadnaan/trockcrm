-- Migration 0030: lead questionnaire v2 foundation
-- Adds config-driven questionnaire nodes in public schema plus tenant answer
-- and answer-history tables. Legacy lead JSON payload columns remain intact.

CREATE TABLE IF NOT EXISTS public.project_type_question_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_type_id UUID REFERENCES public.project_type_config(id),
  parent_node_id UUID REFERENCES public.project_type_question_nodes(id),
  parent_option_value VARCHAR(255),
  node_type VARCHAR(50) NOT NULL DEFAULT 'question',
  key VARCHAR(120) NOT NULL,
  label VARCHAR(255) NOT NULL,
  prompt TEXT,
  input_type VARCHAR(50),
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_type_question_nodes_project_type_idx
  ON public.project_type_question_nodes (project_type_id, display_order);

CREATE INDEX IF NOT EXISTS project_type_question_nodes_parent_idx
  ON public.project_type_question_nodes (parent_node_id, display_order);

CREATE INDEX IF NOT EXISTS project_type_question_nodes_active_idx
  ON public.project_type_question_nodes (is_active, display_order);

DO $$
BEGIN
  CREATE TRIGGER set_project_type_question_nodes_updated_at
    BEFORE UPDATE ON public.project_type_question_nodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
      'CREATE TABLE IF NOT EXISTS %I.lead_question_answers (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         lead_id UUID NOT NULL REFERENCES %I.leads(id),
         question_id UUID NOT NULL REFERENCES public.project_type_question_nodes(id),
         value_json JSONB,
         updated_by UUID REFERENCES public.users(id),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS lead_question_answers_lead_question_uidx
         ON %I.lead_question_answers (lead_id, question_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS lead_question_answers_lead_idx
         ON %I.lead_question_answers (lead_id, updated_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS lead_question_answers_question_idx
         ON %I.lead_question_answers (question_id, updated_at)',
      schema_name
    );

    BEGIN
      EXECUTE format(
        'CREATE TRIGGER set_lead_question_answers_updated_at
           BEFORE UPDATE ON %I.lead_question_answers
           FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        schema_name
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.lead_question_answer_history (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         lead_id UUID NOT NULL REFERENCES %I.leads(id),
         question_id UUID NOT NULL REFERENCES public.project_type_question_nodes(id),
         old_value_json JSONB,
         new_value_json JSONB,
         changed_by UUID REFERENCES public.users(id),
         changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS lead_question_answer_history_lead_idx
         ON %I.lead_question_answer_history (lead_id, changed_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS lead_question_answer_history_question_idx
         ON %I.lead_question_answer_history (question_id, changed_at)',
      schema_name
    );
  END LOOP;
END $$;
