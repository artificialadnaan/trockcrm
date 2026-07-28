-- Migration 0201: indexes for /properties/match — the field-prospecting candidate lookup.
--
-- This query runs at EVERY rep stop, which is a different traffic shape from the rest of the properties
-- module: many small lookups rather than a few large listings. Without support it scans every active
-- property in the office and evaluates a regexp_replace per row, and the cost grows with the table
-- exactly as prospecting drives that table's growth.
--
-- TWO indexes, matching the two candidate predicates in match-service.ts:
--
--   1. The normalised-address expression, used for both an equality (`= key`) and a left-anchored
--      prefix (`LIKE 'housenumber %'`). Declared with text_pattern_ops so ONE index serves both: in a
--      non-C collation a plain btree cannot support LIKE prefix matching, and text_pattern_ops still
--      answers equality. The expression is duplicated from the query VERBATIM — Postgres matches an
--      expression index only on a syntactic match, so any edit to that SQL must be mirrored here or the
--      index silently stops being used, with nothing failing to say so.
--
--   2. (lat, lng) for the bounding box. Partial on the columns being non-null: nothing populated them
--      before this feature, so the overwhelming majority of rows are NULL today and indexing those
--      would be pure overhead. The query compares numeric to numeric for this reason — casting the
--      COLUMN to float8 would make the comparison an expression over lat and leave this index unused.
--
-- CREATE INDEX, not CONCURRENTLY: the migration runner wraps each file in a transaction and
-- CONCURRENTLY cannot run inside one. Per-office property tables are small enough that the brief lock
-- is acceptable; if that stops being true this needs to become an out-of-band step.
--
-- The format() strings are DOLLAR-QUOTED so the embedded SQL keeps its own quotes verbatim. Escaping
-- them by doubling is possible and unreadable — the empty-string literal alone needs four quotes, and
-- getting it wrong yields a migration that parses and builds the wrong expression, which then simply
-- never matches the query.
--
-- Idempotent across all tenant office_* schemas (matches 0196's pattern).

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.properties', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format($idx$
      CREATE INDEX IF NOT EXISTS properties_normalized_address_idx
        ON %I.properties (
          (left(btrim(regexp_replace(translate(lower(coalesce(address, '')), 'áàâäãåÁÀÂÄÃÅéèêëÉÈÊËíìîïÍÌÎÏóòôöõÓÒÔÖÕúùûüÚÙÛÜñÑçÇýÿÝ', 'aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunnccyyy'), '[^a-z0-9]+', ' ', 'g')), 512)) text_pattern_ops
        )
    $idx$, schema_name);

    EXECUTE format($geo$
      CREATE INDEX IF NOT EXISTS properties_lat_lng_idx
        ON %I.properties (lat, lng)
        WHERE lat IS NOT NULL AND lng IS NOT NULL
    $geo$, schema_name);
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner, which swaps office_dallas for the new schema name.
-- TENANT_SCHEMA_START
CREATE INDEX IF NOT EXISTS properties_normalized_address_idx
  ON office_dallas.properties (
    (left(btrim(regexp_replace(translate(lower(coalesce(address, '')), 'áàâäãåÁÀÂÄÃÅéèêëÉÈÊËíìîïÍÌÎÏóòôöõÓÒÔÖÕúùûüÚÙÛÜñÑçÇýÿÝ', 'aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunnccyyy'), '[^a-z0-9]+', ' ', 'g')), 512)) text_pattern_ops
  );

CREATE INDEX IF NOT EXISTS properties_lat_lng_idx
  ON office_dallas.properties (lat, lng)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;
-- TENANT_SCHEMA_END
