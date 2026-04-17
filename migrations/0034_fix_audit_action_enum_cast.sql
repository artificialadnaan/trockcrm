-- Migration 0034: Fix schema-qualified audit trigger enum casts.
-- The dynamic SQL introduced in 0033 must cast the action parameter inside the
-- SQL string so Postgres resolves it as the tenant schema's audit_action enum.

CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER AS $$
DECLARE
  changed_fields JSONB := '{}';
  col_name TEXT;
  old_val TEXT;
  new_val TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format(
      'INSERT INTO %1$I.audit_log (table_name, record_id, action, changed_by, full_row, created_at)
       VALUES ($1, $2, $3::%1$I.audit_action, $4, $5, NOW())',
      TG_TABLE_SCHEMA
    )
    USING
      TG_TABLE_NAME,
      NEW.id,
      'insert',
      NULLIF(current_setting('app.current_user_id', true), '')::UUID,
      to_jsonb(NEW);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR col_name IN
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = TG_TABLE_SCHEMA
        AND table_name = TG_TABLE_NAME
    LOOP
      EXECUTE format('SELECT ($1).%I::TEXT, ($2).%I::TEXT', col_name, col_name)
        INTO old_val, new_val USING OLD, NEW;
      IF old_val IS DISTINCT FROM new_val THEN
        changed_fields := changed_fields || jsonb_build_object(
          col_name,
          jsonb_build_object('old', old_val, 'new', new_val)
        );
      END IF;
    END LOOP;

    IF changed_fields != '{}' THEN
      EXECUTE format(
        'INSERT INTO %1$I.audit_log (table_name, record_id, action, changed_by, changes, created_at)
         VALUES ($1, $2, $3::%1$I.audit_action, $4, $5, NOW())',
        TG_TABLE_SCHEMA
      )
      USING
        TG_TABLE_NAME,
        NEW.id,
        'update',
        NULLIF(current_setting('app.current_user_id', true), '')::UUID,
        changed_fields;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'INSERT INTO %1$I.audit_log (table_name, record_id, action, changed_by, full_row, created_at)
       VALUES ($1, $2, $3::%1$I.audit_action, $4, $5, NOW())',
      TG_TABLE_SCHEMA
    )
    USING
      TG_TABLE_NAME,
      OLD.id,
      'delete',
      NULLIF(current_setting('app.current_user_id', true), '')::UUID,
      to_jsonb(OLD);
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
