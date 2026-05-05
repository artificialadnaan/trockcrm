-- Migration 0078: promote lead bid due date to a tenant leads column

DO $$
DECLARE
  tenant_schema text;
BEGIN
  -- Tenant schemas are provisioned as office_<slug> (see tenantMiddleware and office provisioning).
  -- Keep this filter precise so unrelated non-public schemas are not altered.
  FOR tenant_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office\_%' ESCAPE '\'
    ORDER BY schemata.schema_name
  LOOP
    IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.leads
           ADD COLUMN IF NOT EXISTS bid_due_date date',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL
       AND to_regclass(format('%I.lead_question_answers', tenant_schema)) IS NOT NULL THEN
      -- Backfills existing V2 demo answers. Unparseable date strings are left null;
      -- the create gate now uses leads.bid_due_date as the source of truth.
      EXECUTE format(
        $sql$
        WITH latest_answer AS (
          SELECT DISTINCT ON (lqa.lead_id)
                 lqa.lead_id,
                 btrim(lqa.value_json #>> '{}') AS raw_value
            FROM %I.lead_question_answers AS lqa
            JOIN public.project_type_question_nodes AS node
              ON node.id = lqa.question_id
           WHERE node.key = 'bid_due_date'
             AND lqa.value_json IS NOT NULL
             AND btrim(lqa.value_json #>> '{}') <> ''
           ORDER BY lqa.lead_id, lqa.updated_at DESC, lqa.created_at DESC, lqa.id DESC
        ),
        parsed_answer AS (
          SELECT lead_id,
                 CASE
                   WHEN raw_value ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
                    AND to_char(to_date(raw_value, 'YYYY-MM-DD'), 'YYYY-MM-DD') = raw_value
                   THEN raw_value::date
                   ELSE NULL::date
                 END AS value
            FROM latest_answer
        )
        UPDATE %I.leads AS lead
           SET bid_due_date = parsed_answer.value
          FROM parsed_answer
         WHERE lead.id = parsed_answer.lead_id
           AND lead.bid_due_date IS NULL
           AND parsed_answer.value IS NOT NULL
        $sql$,
        tenant_schema,
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
