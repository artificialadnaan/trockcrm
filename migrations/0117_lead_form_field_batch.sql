-- Migration 0117: Lead form field cleanup batch
-- Idempotent startup migration for the POC role options, Budget/Estimated Value
-- consolidation, and Life Safety boolean conversion.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'lead_poc_role'
  ) THEN
    ALTER TYPE public.lead_poc_role ADD VALUE IF NOT EXISTS 'regional_manager';
    ALTER TYPE public.lead_poc_role ADD VALUE IF NOT EXISTS 'regional_vp';
    ALTER TYPE public.lead_poc_role ADD VALUE IF NOT EXISTS 'vp';
    ALTER TYPE public.lead_poc_role ADD VALUE IF NOT EXISTS 'asset_manager';
    ALTER TYPE public.lead_poc_role ADD VALUE IF NOT EXISTS 'facilities_manager';
    ALTER TYPE public.lead_poc_role ADD VALUE IF NOT EXISTS 'project_manager';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.lead_form_field_batch_life_safety_audit (
  id BIGSERIAL PRIMARY KEY,
  tenant_schema TEXT NOT NULL,
  lead_id UUID NOT NULL,
  question_id UUID NOT NULL,
  original_value_json JSONB,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_form_field_batch_life_safety_audit_uidx UNIQUE (tenant_schema, lead_id, question_id)
);

DO $$
DECLARE
  schema_name_var TEXT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.project_type_question_nodes
    WHERE key = 'budget'
  ) THEN
    FOR schema_name_var IN
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'office\_%' ESCAPE '\'
      ORDER BY schema_name
    LOOP
      IF schema_name_var !~ '^office_[a-z0-9_]+$' THEN
        CONTINUE;
      END IF;

      EXECUTE format(
        $sql$
          UPDATE %I.leads AS l
          SET qualification_payload = jsonb_set(
                COALESCE(l.qualification_payload, '{}'::jsonb),
                '{estimated_value}',
                budget.value_json,
                true
              )
          FROM (
            SELECT DISTINCT ON (a.lead_id)
                   a.lead_id,
                   a.value_json
            FROM %I.lead_question_answers AS a
            JOIN public.project_type_question_nodes AS node
              ON node.id = a.question_id
            WHERE node.key = 'budget'
              AND a.value_json IS NOT NULL
              AND a.value_json::text NOT IN ('null', '""')
            ORDER BY a.lead_id, a.updated_at DESC NULLS LAST, a.created_at DESC NULLS LAST, a.id DESC
          ) AS budget
          WHERE budget.lead_id = l.id
            AND (
              l.qualification_payload->>'estimated_value' IS NULL
              OR btrim(l.qualification_payload->>'estimated_value') = ''
            )
        $sql$,
        schema_name_var,
        schema_name_var
      );
    END LOOP;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.project_type_question_nodes
    WHERE key = 'life_safety'
      AND is_active = true
  ) THEN
    FOR schema_name_var IN
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'office\_%' ESCAPE '\'
      ORDER BY schema_name
    LOOP
      IF schema_name_var !~ '^office_[a-z0-9_]+$' THEN
        CONTINUE;
      END IF;

      EXECUTE format(
        $sql$
          INSERT INTO public.lead_form_field_batch_life_safety_audit (
            tenant_schema,
            lead_id,
            question_id,
            original_value_json
          )
          SELECT $1, a.lead_id, a.question_id, a.value_json
          FROM %I.lead_question_answers AS a
          WHERE a.question_id IN (
              SELECT id
              FROM public.project_type_question_nodes
              WHERE key = 'life_safety'
                AND is_active = true
            )
            AND a.value_json IS NOT NULL
            AND jsonb_typeof(a.value_json) = 'string'
            AND btrim(a.value_json #>> '{}') <> ''
          ON CONFLICT (tenant_schema, lead_id, question_id) DO NOTHING
        $sql$,
        schema_name_var
      )
      USING schema_name_var;

      EXECUTE format(
        $sql$
          UPDATE %I.lead_question_answers AS a
          SET value_json =
                CASE
                  WHEN lower(btrim(audit.original_value_json #>> '{}')) IN ('no', 'n/a', 'na', 'none', 'not applicable', 'false', '0') THEN 'false'::jsonb
                  ELSE 'true'::jsonb
                END,
              updated_at = NOW()
          FROM public.lead_form_field_batch_life_safety_audit AS audit
          WHERE audit.tenant_schema = $1
            AND audit.lead_id = a.lead_id
            AND audit.question_id = a.question_id
            AND jsonb_typeof(audit.original_value_json) = 'string'
            AND btrim(audit.original_value_json #>> '{}') <> ''
            AND jsonb_typeof(a.value_json) = 'string'
            AND a.question_id IN (
              SELECT id
              FROM public.project_type_question_nodes
              WHERE key = 'life_safety'
                AND is_active = true
            )
        $sql$,
        schema_name_var
      )
      USING schema_name_var;
    END LOOP;
  END IF;
END $$;

UPDATE public.project_type_question_nodes
SET is_active = false,
    updated_at = NOW()
WHERE key = 'budget'
  AND is_active = true;

UPDATE public.project_type_question_nodes
SET input_type = 'boolean',
    options = '[]'::jsonb,
    updated_at = NOW()
WHERE key = 'life_safety'
  AND is_active = true;
