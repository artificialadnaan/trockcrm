-- Migration 0076: lead creation prerequisite gate

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typname = 'lead_poc_role'
  ) THEN
    CREATE TYPE public.lead_poc_role AS ENUM (
      'property_manager',
      'construction_manager',
      'director',
      'other'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typname = 'lead_budget_status'
  ) THEN
    CREATE TYPE public.lead_budget_status AS ENUM (
      'budgeted_q1',
      'budgeted_q2',
      'budgeted_q3',
      'budgeted_q4',
      'not_budgeted'
    );
  END IF;
END $$;

DO $$
DECLARE
  tenant_schema text;
  budget_status_udt_name text;
BEGIN
  -- Tenant schemas are provisioned as office_<slug> (see tenantMiddleware and office provisioning).
  -- Keep this filter precise so unrelated non-public schemas are not altered.
  FOR tenant_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office\_%' ESCAPE '\'
    ORDER BY schemata.schema_name
  LOOP
    IF to_regclass(format('%I.properties', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.properties
           ADD COLUMN IF NOT EXISTS build_year integer,
           ADD COLUMN IF NOT EXISTS unit_count integer',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.leads
           ADD COLUMN IF NOT EXISTS primary_contact_role public.lead_poc_role,
           ADD COLUMN IF NOT EXISTS primary_contact_role_other_label text',
        tenant_schema
      );

      SELECT columns.udt_name
      INTO budget_status_udt_name
      FROM information_schema.columns AS columns
      WHERE columns.table_schema = tenant_schema
        AND columns.table_name = 'leads'
        AND columns.column_name = 'budget_status';

      IF budget_status_udt_name IS NOT NULL
         AND budget_status_udt_name <> 'lead_budget_status' THEN
        -- Safe because pre-cutover leads data is demo-only; existing budget values are intentionally not preserved.
        EXECUTE format(
          'UPDATE %I.leads
              SET budget_status = NULL',
          tenant_schema
        );

        EXECUTE format(
          'ALTER TABLE %I.leads
             ALTER COLUMN budget_status DROP DEFAULT',
          tenant_schema
        );

        EXECUTE format(
          'ALTER TABLE %I.leads
             ALTER COLUMN budget_status TYPE public.lead_budget_status
             USING NULL::public.lead_budget_status',
          tenant_schema
        );
      END IF;
    END IF;
  END LOOP;
END $$;

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
