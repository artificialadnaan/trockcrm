-- Migration 0130: align universal lead questionnaire labels and access metadata
-- No leads-table column change is required. These fields are stored in
-- tenant.lead_question_answers.value_json, so we only need to update the
-- questionnaire node metadata and add the conditional Other-detail node.

UPDATE public.project_type_question_nodes
SET
  label = 'Type of access',
  input_type = 'select',
  options = '[{"value":"Gated","label":"Gated"},{"value":"Not Gated","label":"Not Gated"},{"value":"Bobbed","label":"Bobbed"},{"value":"Other","label":"Other"}]'::jsonb,
  is_required = true,
  updated_at = NOW()
WHERE project_type_id IS NULL
  AND key = 'site_access'
  AND is_active = true;

INSERT INTO public.project_type_question_nodes (
  id,
  project_type_id,
  parent_node_id,
  parent_option_value,
  node_type,
  key,
  label,
  prompt,
  input_type,
  options,
  is_required,
  display_order,
  is_active,
  section_key,
  group_key,
  group_label,
  group_order,
  created_at,
  updated_at
)
SELECT
  '50000000-0000-4000-8000-000000001310'::uuid,
  NULL,
  parent.id,
  'Other',
  'question',
  'site_access_other_detail',
  'Type of access detail',
  NULL,
  'text',
  '[]'::jsonb,
  true,
  1310,
  true,
  parent.section_key,
  parent.group_key,
  parent.group_label,
  parent.group_order,
  NOW(),
  NOW()
FROM public.project_type_question_nodes AS parent
WHERE parent.project_type_id IS NULL
  AND parent.key = 'site_access'
  AND parent.is_active = true
ON CONFLICT (id) DO UPDATE
SET
  project_type_id = EXCLUDED.project_type_id,
  parent_node_id = EXCLUDED.parent_node_id,
  parent_option_value = EXCLUDED.parent_option_value,
  node_type = EXCLUDED.node_type,
  key = EXCLUDED.key,
  label = EXCLUDED.label,
  prompt = EXCLUDED.prompt,
  input_type = EXCLUDED.input_type,
  options = EXCLUDED.options,
  is_required = EXCLUDED.is_required,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  section_key = EXCLUDED.section_key,
  group_key = EXCLUDED.group_key,
  group_label = EXCLUDED.group_label,
  group_order = EXCLUDED.group_order,
  updated_at = NOW();

UPDATE public.project_type_question_nodes
SET
  label = 'Number of Units Affected',
  updated_at = NOW()
WHERE project_type_id IS NULL
  AND key = 'number_of_units'
  AND is_active = true;

DO $$
DECLARE
  tenant_schema TEXT;
  site_access_question_id UUID;
  site_access_other_detail_question_id UUID;
BEGIN
  SELECT id
  INTO site_access_question_id
  FROM public.project_type_question_nodes
  WHERE project_type_id IS NULL
    AND key = 'site_access'
    AND is_active = true
  LIMIT 1;

  SELECT id
  INTO site_access_other_detail_question_id
  FROM public.project_type_question_nodes
  WHERE project_type_id IS NULL
    AND key = 'site_access_other_detail'
    AND is_active = true
  LIMIT 1;

  IF site_access_question_id IS NULL OR site_access_other_detail_question_id IS NULL THEN
    RETURN;
  END IF;

  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office\_%' ESCAPE '\'
    ORDER BY schema_name
  LOOP
    IF tenant_schema !~ '^office_[a-z0-9_]+$' THEN
      CONTINUE;
    END IF;

    IF to_regclass(format('%I.lead_question_answers', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        UPDATE %I.lead_question_answers AS detail
        SET value_json = to_jsonb(btrim(parent.value_json #>> '{}')),
            updated_at = NOW()
        FROM %I.lead_question_answers AS parent
        WHERE parent.lead_id = detail.lead_id
          AND parent.question_id = %L::uuid
          AND detail.question_id = %L::uuid
          AND parent.value_json IS NOT NULL
          AND jsonb_typeof(parent.value_json) = 'string'
          AND btrim(parent.value_json #>> '{}') <> ''
          AND btrim(parent.value_json #>> '{}') NOT IN ('Gated', 'Not Gated', 'Bobbed', 'Other')
          AND (
            detail.value_json IS NULL
            OR jsonb_typeof(detail.value_json) <> 'string'
            OR btrim(detail.value_json #>> '{}') = ''
          )
      $sql$,
      tenant_schema,
      tenant_schema,
      site_access_question_id,
      site_access_other_detail_question_id
    );

    EXECUTE format(
      $sql$
        INSERT INTO %I.lead_question_answers (
          lead_id,
          question_id,
          value_json,
          updated_by,
          created_at,
          updated_at
        )
        SELECT
          parent.lead_id,
          %L::uuid,
          to_jsonb(btrim(parent.value_json #>> '{}')),
          parent.updated_by,
          COALESCE(parent.created_at, NOW()),
          NOW()
        FROM %I.lead_question_answers AS parent
        WHERE parent.question_id = %L::uuid
          AND parent.value_json IS NOT NULL
          AND jsonb_typeof(parent.value_json) = 'string'
          AND btrim(parent.value_json #>> '{}') <> ''
          AND btrim(parent.value_json #>> '{}') NOT IN ('Gated', 'Not Gated', 'Bobbed', 'Other')
          AND NOT EXISTS (
            SELECT 1
            FROM %I.lead_question_answers AS detail
            WHERE detail.lead_id = parent.lead_id
              AND detail.question_id = %L::uuid
          )
      $sql$,
      tenant_schema,
      site_access_other_detail_question_id,
      tenant_schema,
      site_access_question_id,
      tenant_schema,
      site_access_other_detail_question_id
    );

    EXECUTE format(
      $sql$
        UPDATE %I.lead_question_answers AS parent
        SET value_json = '"Other"'::jsonb,
            updated_at = NOW()
        WHERE parent.question_id = %L::uuid
          AND parent.value_json IS NOT NULL
          AND jsonb_typeof(parent.value_json) = 'string'
          AND btrim(parent.value_json #>> '{}') <> ''
          AND btrim(parent.value_json #>> '{}') NOT IN ('Gated', 'Not Gated', 'Bobbed', 'Other')
      $sql$,
      tenant_schema,
      site_access_question_id
    );
  END LOOP;
END $$;
