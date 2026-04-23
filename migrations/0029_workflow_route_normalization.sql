-- Migration 0029: normalize workflow route vocabulary to normal/service
-- Upgrades already-migrated tenant schemas from the legacy estimating/service
-- contract without rewriting the original sales scoping intake migration.

DO $$
DECLARE
  tenant_schema TEXT;
  enum_has_estimating BOOLEAN;
  enum_has_normal BOOLEAN;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = tenant_schema
        AND t.typname = 'workflow_route'
        AND e.enumlabel = 'estimating'
    )
    INTO enum_has_estimating;

    SELECT EXISTS (
      SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = tenant_schema
        AND t.typname = 'workflow_route'
        AND e.enumlabel = 'normal'
    )
    INTO enum_has_normal;

    IF enum_has_estimating AND NOT enum_has_normal THEN
      EXECUTE format(
        'ALTER TYPE %I.workflow_route RENAME VALUE ''estimating'' TO ''normal''',
        tenant_schema
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = tenant_schema
        AND table_name = 'deals'
        AND column_name = 'workflow_route'
    ) THEN
      EXECUTE format(
        'UPDATE %I.deals
            SET workflow_route = ''normal''
          WHERE workflow_route::text = ''estimating''',
        tenant_schema
      );
      EXECUTE format(
        'UPDATE %I.deals
            SET workflow_route = ''normal''
          WHERE workflow_route IS NULL',
        tenant_schema
      );
      EXECUTE format(
        'ALTER TABLE %I.deals
           ALTER COLUMN workflow_route SET DEFAULT ''normal''',
        tenant_schema
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = tenant_schema
        AND table_name = 'deal_scoping_intake'
        AND column_name = 'workflow_route_snapshot'
    ) THEN
      EXECUTE format(
        'UPDATE %I.deal_scoping_intake
            SET workflow_route_snapshot = ''normal''
          WHERE workflow_route_snapshot::text = ''estimating''',
        tenant_schema
      );
      EXECUTE format(
        'UPDATE %I.deal_scoping_intake
            SET workflow_route_snapshot = ''normal''
          WHERE workflow_route_snapshot IS NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
