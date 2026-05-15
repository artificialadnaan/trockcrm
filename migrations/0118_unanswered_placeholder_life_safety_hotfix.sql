-- Migration 0118: normalize persisted __unanswered__ questionnaire strings
-- and reassert Life Safety as a boolean yes/no question.

DO $$
DECLARE
  schema_name_var TEXT;
  affected_count INTEGER;
BEGIN
  FOR schema_name_var IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'office_%'
    ORDER BY schema_name
  LOOP
    EXECUTE format(
      $sql$
        UPDATE %I.lead_question_answers AS a
        SET value_json = 'null'::jsonb,
            updated_at = NOW()
        WHERE jsonb_typeof(a.value_json) = 'string'
          AND btrim(a.value_json #>> '{}') = '__unanswered__'
          AND a.question_id IN (
            SELECT id
            FROM public.project_type_question_nodes
            WHERE is_active = true
              AND (
                key = 'life_safety'
                OR input_type = 'boolean'
                OR input_type = 'select'
                OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) > 0)
              )
          )
      $sql$,
      schema_name_var
    );

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    RAISE NOTICE '0118_unanswered_placeholder_life_safety_hotfix: normalized % rows in %', affected_count, schema_name_var;

    UPDATE public.project_type_question_nodes
    SET input_type = 'boolean',
        options = '[]'::jsonb,
        updated_at = NOW()
    WHERE key = 'life_safety'
      AND is_active = true
      AND (
        input_type IS DISTINCT FROM 'boolean'
        OR options IS DISTINCT FROM '[]'::jsonb
      );

    GET DIAGNOSTICS affected_count = ROW_COUNT;
    RAISE NOTICE '0118_unanswered_placeholder_life_safety_hotfix: updated % life_safety node rows while processing %', affected_count, schema_name_var;
  END LOOP;
END $$;
