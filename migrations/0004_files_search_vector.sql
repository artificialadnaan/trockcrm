-- Migration 0004: Add search_vector column and GIN indexes to files table
-- SAFETY NET: Only runs if files table exists in the current schema.
-- On a fresh database with no tenants, this is a no-op.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'files' AND table_schema = current_schema()) THEN
    ALTER TABLE files ADD COLUMN IF NOT EXISTS search_vector tsvector;
    CREATE INDEX IF NOT EXISTS files_search_vector_idx ON files USING GIN (search_vector);
    CREATE INDEX IF NOT EXISTS files_tags_gin_idx ON files USING GIN (tags);
    CREATE INDEX IF NOT EXISTS files_version_chain_idx ON files (parent_file_id, version) WHERE parent_file_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS files_photo_timeline_idx ON files (deal_id, category, COALESCE(taken_at, created_at) DESC) WHERE category = 'photo' AND is_active = TRUE;
    CREATE INDEX IF NOT EXISTS files_contact_idx ON files (contact_id, category, created_at DESC) WHERE contact_id IS NOT NULL;
  END IF;
END $$;
