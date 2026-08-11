-- Migration 0218: deals.scope_title — a SHORT, accounting-readable title for the scope of work.
--
-- Accounting keys a project title into QuickBooks. Today the only free-text slot on a deal is
-- `description` (text, 5000-char form cap), which is a notes field being asked to do a title's job: the
-- same column produces "Balcony Repair" on one deal and a twelve-question wall of text about budgets and
-- site visits on the next. There is no short-form field to fall back to, so this adds one.
--
-- varchar(120) is deliberate and load-bearing. The whole point of the field is that it CANNOT become
-- another notes dump, so the cap is enforced in three places (form, API, column) rather than one. 120 is
-- long enough for the longest real example accounting gave — "Clear backup clog from bathroom toilet unit
-- 4350-201b" (54 chars) — with roughly double the headroom, and short enough that a paragraph does not
-- fit. The API rejects an over-length value with a 400 before the column ever sees it; the varchar is the
-- backstop for any writer that skips the route (a script, a future importer).
--
-- Nullable with no default and no backfill. It is deliberately NOT required: sales already under-fill
-- `description`, and a hard block would be answered with junk typed to get past it. Existing deals stay
-- NULL and the detail card renders nothing for them rather than an empty gap.
--
-- deals is a per-tenant office_* table, so this needs BOTH halves: the DO-loop retro-fits every schema
-- that exists now, and the TENANT_SCHEMA block is what the office provisioner replays for schemas created
-- after this deploy. Either half alone leaves some office without the column.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- A half-provisioned schema (created, tables not yet cloned) must be skipped, not abort the block.
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS scope_title varchar(120)',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS scope_title varchar(120);
-- TENANT_SCHEMA_END
