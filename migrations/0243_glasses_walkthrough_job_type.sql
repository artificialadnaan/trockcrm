-- Migration 0243: `glasses_walkthroughs.job_type` — WHAT KIND of work is this walk about?
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/024*' 'migrations/025*'
-- Across all remote heads plus the in-flight worktrees at authoring time: 0240 (tasks last_assigned_by),
-- 0241 (files association check repair), 0242 (weekly report delivery recorded_at — NOT on origin/main,
-- which is exactly the case the provenance rule exists for). 0243 is the first free number.
--
-- WHY. TROCK Scope grounds a walk against a work-type catalog chosen by the walk's `job_type`, and the
-- CRM has never sent one — so `POST /api/walkthroughs` falls back to its default, `interior_finish_out`,
-- for EVERY walk this company has ever filed. That default is wrong for most of them: the field crews
-- walk exteriors, and an exterior walk graded against an interior catalog matches almost nothing.
-- Measured on a real walk before the exterior catalog existed: 0 of 141 line items matched. With the
-- right catalog behind it, a 40-moment sample went from 10% categorised to 65%.
--
-- Categorised is not cosmetic. It is what carries a CSI section to Bid Board, what puts plausibility
-- bounds on a spoken number, what boosts the transcriber's vocabulary, and what the consolidated
-- roll-up groups on. A walk with no work types produces a list nobody can total.
--
-- NULLABLE, AND NULL IS A REAL ANSWER. It means "nobody stated one", and the forward job then OMITS the
-- field from its create call rather than inventing a value — so TROCK Scope applies exactly the default
-- it applies today. Every historical row, and every walk filed by a client that does not yet send this,
-- behaves byte-for-byte as it does now. That matters more than usual right now: the capture clients are
-- unchanged by this migration, so on the day it ships nothing about ingest moves at all.
--
-- NO CHECK CONSTRAINT, DELIBERATELY. The authoritative list is `JOB_TYPES` in the trock-scope repo
-- (shared/src/schema/enums.ts), and TROCK Scope validates it on the way in. The ingest route validates it
-- again at this end so a bad value is a 400 to the caller rather than a 422 discovered three hops later
-- inside a retrying background job. A third copy of the list, in SQL, could only ever drift: the day
-- TROCK Scope adds a job type, a CHECK here would reject it until somebody remembered to write a
-- migration, and the failure would surface as walks refused at ingest for no visible reason.
--
-- varchar(40) bounds it against the unbounded jsonb the value arrives in. The longest current value,
-- `interior_finish_out`, is 19 characters; 40 leaves room without letting a payload write an essay.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    -- An office provisioned before 0214 has no glasses table at all. Skipping is correct rather than
    -- defensive: the provisioner's own tenant template below carries the column, so such an office gets
    -- it whenever the table itself arrives.
    IF to_regclass(format('%I.glasses_walkthroughs', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.glasses_walkthroughs ADD COLUMN IF NOT EXISTS job_type varchar(40)',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner, which lifts the block between these markers and rewrites
-- `office_dallas` to the new schema name (server/src/modules/office/service.ts). It must stay in PARITY
-- with the DO-loop above — a column added only in the loop exists for today's offices and silently does
-- not exist for the next one provisioned, which is a 42703 on an ingest nobody can reproduce.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.glasses_walkthroughs
  ADD COLUMN IF NOT EXISTS job_type varchar(40);
-- TENANT_SCHEMA_END

COMMENT ON COLUMN office_dallas.glasses_walkthroughs.job_type IS
  'Which TROCK Scope work-type catalog this walk should be graded against — interior_finish_out, roofing_envelope, commercial_ti or service_repair. NULL means nobody stated one, and the forward job then omits it so TROCK Scope applies its own default. The authoritative list is JOB_TYPES in the trock-scope repo; there is deliberately no CHECK here. Migration 0243.';
