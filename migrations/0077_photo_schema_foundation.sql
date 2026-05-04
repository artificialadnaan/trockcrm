ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'field_contractor';

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = tenant_schema AND table_name = 'files') THEN
      IF to_regtype(format('%I.photo_address_source', tenant_schema)) IS NULL THEN
        EXECUTE format('CREATE TYPE %I.photo_address_source AS ENUM (''exif'', ''live_gps'', ''deal_fallback'', ''manual_override'')', tenant_schema);
      ELSE
        EXECUTE format('ALTER TYPE %I.photo_address_source ADD VALUE IF NOT EXISTS ''exif''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_address_source ADD VALUE IF NOT EXISTS ''live_gps''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_address_source ADD VALUE IF NOT EXISTS ''deal_fallback''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_address_source ADD VALUE IF NOT EXISTS ''manual_override''', tenant_schema);
      END IF;

      IF to_regtype(format('%I.photo_category', tenant_schema)) IS NULL THEN
        EXECUTE format('CREATE TYPE %I.photo_category AS ENUM (''before'', ''after'', ''progress'', ''site_visit'', ''damage'', ''safety'', ''delivery'', ''other'')', tenant_schema);
      ELSE
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''before''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''after''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''progress''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''site_visit''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''damage''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''safety''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''delivery''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_category ADD VALUE IF NOT EXISTS ''other''', tenant_schema);
      END IF;

      IF to_regtype(format('%I.procore_photo_sync_status', tenant_schema)) IS NULL THEN
        EXECUTE format('CREATE TYPE %I.procore_photo_sync_status AS ENUM (''pending'', ''synced'', ''failed'', ''skipped'')', tenant_schema);
      ELSE
        EXECUTE format('ALTER TYPE %I.procore_photo_sync_status ADD VALUE IF NOT EXISTS ''pending''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.procore_photo_sync_status ADD VALUE IF NOT EXISTS ''synced''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.procore_photo_sync_status ADD VALUE IF NOT EXISTS ''failed''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.procore_photo_sync_status ADD VALUE IF NOT EXISTS ''skipped''', tenant_schema);
      END IF;

      IF to_regtype(format('%I.photo_audit_event_type', tenant_schema)) IS NULL THEN
        EXECUTE format('CREATE TYPE %I.photo_audit_event_type AS ENUM (''uploaded'', ''category_changed'', ''address_changed'', ''caption_changed'', ''downloaded'', ''deleted'', ''restored'', ''procore_synced'', ''procore_sync_failed'')', tenant_schema);
      ELSE
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''uploaded''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''category_changed''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''address_changed''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''caption_changed''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''downloaded''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''deleted''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''restored''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''procore_synced''', tenant_schema);
        EXECUTE format('ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''procore_sync_failed''', tenant_schema);
      END IF;

      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS latitude numeric(10,7)', tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS longitude numeric(10,7)', tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS address text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS address_source %I.photo_address_source', tenant_schema, tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS geocoded_at timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS photo_category %I.photo_category', tenant_schema, tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS deleted_at timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid REFERENCES public.users(id)', tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS procore_sync_status %I.procore_photo_sync_status', tenant_schema, tenant_schema);
      EXECUTE format('ALTER TABLE %I.files ADD COLUMN IF NOT EXISTS procore_photo_id text', tenant_schema);

      EXECUTE format($sql$
        CREATE TABLE IF NOT EXISTS %I.photo_audit_log (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          photo_id uuid NOT NULL REFERENCES %I.files(id) ON DELETE CASCADE,
          event_type %I.photo_audit_event_type NOT NULL,
          user_id uuid NOT NULL REFERENCES public.users(id),
          created_at timestamptz NOT NULL DEFAULT now(),
          ip_address text,
          user_agent text,
          metadata jsonb
        )
      $sql$, tenant_schema, tenant_schema, tenant_schema);

      EXECUTE format('CREATE INDEX IF NOT EXISTS photo_audit_log_photo_idx ON %I.photo_audit_log(photo_id)', tenant_schema);
      EXECUTE format('CREATE INDEX IF NOT EXISTS photo_audit_log_user_idx ON %I.photo_audit_log(user_id)', tenant_schema);
      EXECUTE format('CREATE INDEX IF NOT EXISTS photo_audit_log_photo_created_idx ON %I.photo_audit_log(photo_id, created_at DESC)', tenant_schema);
      EXECUTE format('CREATE INDEX IF NOT EXISTS photo_audit_log_user_created_idx ON %I.photo_audit_log(user_id, created_at DESC)', tenant_schema);

      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = tenant_schema AND table_name = 'deals') THEN
        EXECUTE format($sql$
          CREATE TABLE IF NOT EXISTS %I.field_user_starred_projects (
            user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
            deal_id uuid NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
            starred_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT field_user_starred_projects_user_id_deal_id_pk PRIMARY KEY (user_id, deal_id)
          )
        $sql$, tenant_schema, tenant_schema);

        EXECUTE format('CREATE INDEX IF NOT EXISTS field_user_starred_projects_user_idx ON %I.field_user_starred_projects(user_id)', tenant_schema);
      END IF;

      RAISE NOTICE 'Applied photo schema foundation migration to schema: %', tenant_schema;
    END IF;
  END LOOP;
END $$;
