DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.files', tenant_schema)) IS NOT NULL THEN
      IF to_regtype(format('%I.photo_audit_event_type', tenant_schema)) IS NOT NULL THEN
        EXECUTE format(
          'ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''voice_description_transcribed''',
          tenant_schema
        );
      END IF;

      EXECUTE format(
        $sql$
          CREATE TABLE IF NOT EXISTS %I.photo_tags (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            photo_id UUID NOT NULL REFERENCES %I.files(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by_user_id UUID NOT NULL REFERENCES public.users(id),
            CONSTRAINT photo_tags_photo_id_tag_pk UNIQUE (photo_id, tag)
          );

          CREATE INDEX IF NOT EXISTS photo_tags_photo_idx ON %I.photo_tags(photo_id);
          CREATE INDEX IF NOT EXISTS photo_tags_tag_idx ON %I.photo_tags(tag);
          CREATE INDEX IF NOT EXISTS photo_tags_created_at_idx ON %I.photo_tags(created_at DESC);
          CREATE INDEX IF NOT EXISTS photo_tags_photo_created_idx ON %I.photo_tags(photo_id, created_at DESC);
        $sql$,
        tenant_schema,
        tenant_schema,
        tenant_schema,
        tenant_schema,
        tenant_schema,
        tenant_schema
      );
    END IF;
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
DO $tenant_schema$
BEGIN
  IF to_regclass('files') IS NOT NULL THEN
    IF to_regtype('photo_audit_event_type') IS NOT NULL THEN
      ALTER TYPE photo_audit_event_type ADD VALUE IF NOT EXISTS 'voice_description_transcribed';
    END IF;

    CREATE TABLE IF NOT EXISTS photo_tags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      photo_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_user_id UUID NOT NULL REFERENCES public.users(id),
      CONSTRAINT photo_tags_photo_id_tag_pk UNIQUE (photo_id, tag)
    );

    CREATE INDEX IF NOT EXISTS photo_tags_photo_idx ON photo_tags(photo_id);
    CREATE INDEX IF NOT EXISTS photo_tags_tag_idx ON photo_tags(tag);
    CREATE INDEX IF NOT EXISTS photo_tags_created_at_idx ON photo_tags(created_at DESC);
    CREATE INDEX IF NOT EXISTS photo_tags_photo_created_idx ON photo_tags(photo_id, created_at DESC);
  END IF;
END
$tenant_schema$;
-- TENANT_SCHEMA_END
