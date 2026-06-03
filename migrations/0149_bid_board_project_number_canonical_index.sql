-- Migration 0149: canonical unique index for bid_board_project_number
--
-- Replaces the raw per-tenant unique index created in migration 0064
-- (deals_bid_board_project_number_uidx) with a FUNCTIONAL unique index on the canonical
-- project number, so values that differ only by Unicode dash glyph (U+2010..U+2015),
-- non-breaking space (U+00A0), letter case, or surrounding whitespace cannot be stored as
-- divergent duplicates.
--
-- The canonical expression MUST stay in lockstep with canonicalProjectNumberSql() in
-- server/src/modules/bid-board-sync/project-number.ts (the Bid Board matcher); a test
-- (bid-board-project-number-canonical-index-migration.test.ts) asserts the match.
--
-- Requires PostgreSQL 13+ for normalize(text, NFC) (the CRM runs PG 18). normalize,
-- translate, lower and btrim are all IMMUTABLE, so the expression is index-eligible.

DO $mig$
DECLARE
  tenant_schema text;
  collision_count integer;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    -- Pre-detect canonical collisions so the migration fails with a clear message rather
    -- than a cryptic unique_violation when the index is built.
    EXECUTE format(
      $chk$
        SELECT count(*) FROM (
          SELECT lower(btrim(translate(normalize(bid_board_project_number, NFC), E'‐‑‒–—― ', '------'), chr(32)||chr(9)||chr(10)||chr(11)||chr(12)||chr(13))) AS canon
          FROM %I.deals
          WHERE bid_board_project_number IS NOT NULL
          GROUP BY 1
          HAVING count(*) > 1
        ) collisions
      $chk$,
      tenant_schema
    ) INTO collision_count;

    IF collision_count > 0 THEN
      RAISE EXCEPTION 'Migration 0149: % canonical bid_board_project_number collision group(s) in %.deals — resolve case/dash/NBSP duplicate project numbers before applying the canonical unique index', collision_count, tenant_schema;
    END IF;

    EXECUTE format('DROP INDEX IF EXISTS %I.%I', tenant_schema, 'deals_bid_board_project_number_uidx');

    EXECUTE format(
      $idx$
        CREATE UNIQUE INDEX IF NOT EXISTS deals_bid_board_project_number_canonical_uidx
          ON %I.deals (lower(btrim(translate(normalize(bid_board_project_number, NFC), E'‐‑‒–—― ', '------'), chr(32)||chr(9)||chr(10)||chr(11)||chr(12)||chr(13))))
          WHERE bid_board_project_number IS NOT NULL
      $idx$,
      tenant_schema
    );

    -- Non-unique canonical indexes for the other two Tier-2 match columns so the
    -- canonicalized lookup in findDealMatches stays index-backed (project_number and
    -- deal_number have their own uniqueness rules, hence NON-unique here). The expression
    -- MUST match canonicalProjectNumberSql() for those columns.
    EXECUTE format(
      $pn$
        CREATE INDEX IF NOT EXISTS deals_project_number_canonical_idx
          ON %I.deals (lower(btrim(translate(normalize(project_number, NFC), E'‐‑‒–—― ', '------'), chr(32)||chr(9)||chr(10)||chr(11)||chr(12)||chr(13))))
          WHERE project_number IS NOT NULL
      $pn$,
      tenant_schema
    );

    EXECUTE format(
      $dn$
        CREATE INDEX IF NOT EXISTS deals_deal_number_canonical_idx
          ON %I.deals (lower(btrim(translate(normalize(deal_number, NFC), E'‐‑‒–—― ', '------'), chr(32)||chr(9)||chr(10)||chr(11)||chr(12)||chr(13))))
      $dn$,
      tenant_schema
    );
  END LOOP;
END $mig$;
