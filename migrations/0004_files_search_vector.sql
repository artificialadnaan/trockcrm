-- Migration 0004: Add search_vector column and GIN indexes to files table
-- NOTE: 0003 is already taken by 0003_disable_stage_history_trigger.sql.
-- Must run per office schema (the migration runner loops across all schemas).
--
-- SAFETY NET: search_vector, GIN indexes, and version chain indexes are already
-- created in 0001_initial.sql tenant DDL section. This migration exists as a
-- safety net for any offices provisioned before the 0001 update was deployed.
-- All statements use IF NOT EXISTS guards so re-running is harmless.

-- 1. Add the generated tsvector column for full-text search.
--    Weighted: display_name (A), description + tags (B), notes (C).
--    Uses array_to_string to convert the text[] tags column to a searchable string.
ALTER TABLE files ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(display_name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(description, '') || ' ' || array_to_string(tags, ' ')), 'B') ||
    setweight(to_tsvector('english', COALESCE(notes, '')), 'C')
  ) STORED;

-- 2. GIN index on search_vector for full-text search queries.
CREATE INDEX IF NOT EXISTS files_search_vector_idx ON files USING GIN (search_vector);

-- 3. GIN index on tags array for tag filtering (@> operator).
CREATE INDEX IF NOT EXISTS files_tags_gin_idx ON files USING GIN (tags);

-- 4. Index for version chain queries (parent_file_id + version).
-- Fix 14: IF NOT EXISTS guard for idempotency (may already exist from tenant DDL in 0001).
CREATE INDEX IF NOT EXISTS files_version_chain_idx ON files (parent_file_id, version)
  WHERE parent_file_id IS NOT NULL;

-- 5. Index for photo timeline queries (deal_id + category + taken_at).
-- Fix 14: IF NOT EXISTS guard for idempotency.
CREATE INDEX IF NOT EXISTS files_photo_timeline_idx
  ON files (deal_id, category, COALESCE(taken_at, created_at) DESC)
  WHERE category = 'photo' AND is_active = TRUE;

-- 6. Index for contact files lookup.
-- Fix 14: IF NOT EXISTS guard for idempotency.
CREATE INDEX IF NOT EXISTS files_contact_idx ON files (contact_id, category, created_at DESC)
  WHERE contact_id IS NOT NULL;
