-- 0178_files_search_vector_original_filename.sql
-- Extend files_search_vector_trigger() to index original_filename (weight B) so users can find files by
-- their REAL uploaded name, not just the (possibly still-auto-generated) display_name.
--
-- Per-tenant: the trigger FUNCTION lives in every office_* schema (0001 defines it under the tenant
-- search_path). A public-only CREATE OR REPLACE would change NOTHING in prod, so we loop each schema and
-- CREATE OR REPLACE the SCHEMA-QUALIFIED function; the TENANT_SCHEMA block (written with the office_dallas
-- literal, per the 0169 exemplar) re-defines it for new clones AND, at migrate time under the default
-- public search_path, re-creates office_dallas's copy — NOT a dangling public function.
--
-- LOCKSTEP: the function body below is written TWICE (DO-loop %I copy + TENANT_SCHEMA office_dallas copy).
-- They MUST stay byte-identical after normalizing %I -> office_dallas; the search-vector runtime test
-- asserts this. Edit both together.
--
-- Normalization: strip the extension and split [._-] into spaces so 'Foundation_Warranty.pdf' tokenizes
-- into searchable words (the default tsvector parser keeps 'Warranty.pdf' as one file/host token).
-- Synthetic exclusion (shared sentinel): for a SYNTHETIC photo (category='photo' with a
-- field-photo-<ts>/companycam_ name) the machine name indexes as '' so its synthetic-only token ('field')
-- doesn't pollute search. A genuine web/desktop PHOTO (real original_filename) is indexed by its real name
-- just like a document; a NON-photo doc shaped like 'field-photo-2024.pdf' is likewise indexed by its real
-- name (it is not category='photo').
--
-- NO reindex here (would lock the whole files table + bump updated_at on every row via set_files_updated_at).
-- Existing rows are reindexed by scripts/backfill-file-display-names.ts (batched, --commit, Adnaan runs it).
-- Idempotent / replayable.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.files', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION %I.files_search_vector_trigger()
      RETURNS TRIGGER AS $body$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english'::regconfig, COALESCE(NEW.display_name, '')), 'A') ||
          setweight(to_tsvector('english'::regconfig, COALESCE(NEW.description, '') || ' ' || array_to_string(NEW.tags, ' ')), 'B') ||
          setweight(to_tsvector('english'::regconfig, COALESCE(
            CASE
              WHEN NEW.category = 'photo' AND NEW.original_filename ~ '^(field-photo-[0-9]+|companycam_)' THEN ''
              ELSE regexp_replace(regexp_replace(NEW.original_filename, '\.[^.]*$', ''), '[._-]+', ' ', 'g')
            END, '')), 'B') ||
          setweight(to_tsvector('english'::regconfig, COALESCE(NEW.notes, '')), 'C');
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    $fn$, schema_name);
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner. It extracts this block, replaces office_dallas -> the new
-- schema, and runs it under SET LOCAL search_path='<schema>','public'. Written with the office_dallas
-- literal (0169 pattern) so at migrate time it (re)creates office_dallas.files_search_vector_trigger()
-- (redundant with the DO-loop above) and NEVER creates a stray public.* function.
-- This body MUST match the DO-loop body above byte-for-byte after %I -> office_dallas (test-asserted).
-- TENANT_SCHEMA_START
CREATE OR REPLACE FUNCTION office_dallas.files_search_vector_trigger()
RETURNS TRIGGER AS $body$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english'::regconfig, COALESCE(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, COALESCE(NEW.description, '') || ' ' || array_to_string(NEW.tags, ' ')), 'B') ||
    setweight(to_tsvector('english'::regconfig, COALESCE(
      CASE
        WHEN NEW.category = 'photo' AND NEW.original_filename ~ '^(field-photo-[0-9]+|companycam_)' THEN ''
        ELSE regexp_replace(regexp_replace(NEW.original_filename, '\.[^.]*$', ''), '[._-]+', ' ', 'g')
      END, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, COALESCE(NEW.notes, '')), 'C');
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;
-- TENANT_SCHEMA_END
