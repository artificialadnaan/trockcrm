-- Migration 0219: `public.users.generates_sales` — the per-person "does this person carry deals?"
-- flag that decides who appears in the DIRECTOR DASHBOARD ROSTERS.
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/021*' 'migrations/022*'
-- Highest across ALL remote heads at authoring time: 0218 (0218_deals_scope_title.sql). 0215 is claimed
-- TWICE across branches (0215_backfill_needs_quantity on #1029 and an abandoned
-- 0215_portfolio_projects_board_relevant_backfill that was renumbered to 0216), which is exactly the
-- collision that search exists to catch. 0219 is free.
--
-- WHY A FLAG AND NOT A ROLE.
-- The dashboard roster asks two INDEPENDENT questions and `users.role` can only answer one of them:
--   1. what may this person SEE/DO?           -> role (admin / director / rep / construction / …)
--   2. is this person expected to CARRY DEALS? -> this column
-- Conflating them forces a new role to be invented for every new combination. The counterexample that
-- settled it: a director who WILL run deals needs director ACCESS and sales ATTRIBUTION at the same
-- time; under a role model that is a role that does not exist. Meanwhile estimators and managers are
-- given role='rep' purely so they can use the CRM, and the dashboard then judges them on a job they
-- were never given. Precedent for the shape: `users.is_test_data` (migration 0142) is the same kind of
-- global per-person roster flag, and is read two lines away in the same predicates.
--
-- DEFAULT true IS DELIBERATE. A default of false would empty the dashboard on deploy until every real
-- rep was re-ticked by hand — an outage dressed as a cleanup. Ticking is the safe direction; the
-- REMOVAL of someone is what must be deliberate and visible, so it happens in the admin UI, by a human,
-- one person at a time.
--
-- THE BACKFILL IS A DELIBERATE NO-OP FOR THE DASHBOARD. It sets false only for people who could not
-- appear on the dashboard TODAY anyway (neither role='rep' nor the owner of any deal in any office).
-- So deploying this migration changes WHO IS ON THE DASHBOARD by exactly zero people. It does not, and
-- must not, clean the roster by itself — the estimators/managers Adnaan wants gone are carrying
-- role='rep' for CRM access and are therefore left `true` here, to be unticked in the UI. That is the
-- point: this file makes the cleanup POSSIBLE and auditable; it does not perform it silently.
--
-- It also does NOT put anyone new on the dashboard. A director with no deals yet stays invisible until
-- an admin ticks them — which is the intended first use of the toggle.
--
-- SCOPE: ROSTERS ONLY, NEVER A MONEY TOTAL. Read by the four director-dashboard ROSTER queries in
-- server/src/modules/dashboard/service.ts (buildRepPerformanceCards, getDirectorFunnelSummary,
-- getRepPerformanceSnapshots, getDirectorRepCommissionRows). It is deliberately NOT read by
-- getCommissionOfficeTotals or getOverrideEarnedCommission, which compute MONEY — a roster-hygiene flag
-- must never be able to move a financial figure (the same boundary migration 0142 drew for is_test_data).
-- In the one place where the two meet (getDirectorRepCommissionRows), the flag is OR'd with an
-- "actually earned" EXISTS, so unticking a person can never hide commission they really hold.
--
-- `users` is a single SHARED (non-tenant) table, so the ALTER is a plain one: no per-tenant office_*
-- loop and no provisioner replay block (contrast a migration adding a column to office_*.deals). The
-- READ side of the backfill does loop the tenant schemas, because deal ownership lives in each of them.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS generates_sales boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.users.generates_sales IS
  'Roster flag: is this person expected to carry deals? Gates the director-dashboard rosters only — never a money total. Orthogonal to users.role (access) by design. Migration 0219.';

DO $$
DECLARE
  tenant_schema text;
  schema_owner_ids uuid[];
  owner_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Re-run guard. Migrations are tracked in public._migrations so this normally executes once, but the
  -- file is also the kind of thing someone replays by hand against a restored dump. After the first run
  -- at least one row is false (there is always a field_contractor or admin who owns nothing), so this
  -- test distinguishes "never classified" from "classified, then edited by a human in the UI" — and
  -- stops a replay from silently reverting every deliberate untick an admin has made since.
  IF EXISTS (SELECT 1 FROM public.users WHERE generates_sales = false) THEN
    RAISE NOTICE '0219: generates_sales already classified; leaving admin edits intact.';
    RETURN;
  END IF;

  -- Deal ownership is per-tenant (office_*.deals), so the "has ever owned a deal" half of today's
  -- roster predicate has to be gathered schema by schema. to_regclass guards a half-provisioned schema
  -- (a tenant mid-creation with no deals table yet) instead of aborting the whole migration on it.
  FOR tenant_schema IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NULL THEN
      RAISE NOTICE '0219: skipping %, no deals table', tenant_schema;
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT COALESCE(array_agg(DISTINCT d.assigned_rep_id), ARRAY[]::uuid[])
         FROM %I.deals d
        WHERE d.assigned_rep_id IS NOT NULL',
      tenant_schema
    ) INTO schema_owner_ids;

    owner_ids := owner_ids || schema_owner_ids;
  END LOOP;

  -- The complement of today's live predicate: NOT a rep, and NOT a deal owner anywhere. These people are
  -- already absent from every dashboard roster, so flipping them to false is invisible — which is the
  -- whole design of this backfill.
  UPDATE public.users u
     SET generates_sales = false
   WHERE u.role <> 'rep'
     AND NOT (u.id = ANY (owner_ids));
END $$;
