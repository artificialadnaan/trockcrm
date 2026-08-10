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
-- THE BACKFILL IS A DELIBERATE NO-OP FOR THE DASHBOARD, and the roster predicate is what makes that
-- true cheaply. Ownership is NOT folded into this flag: the predicate keeps its own tenant-local
-- `owner_rows` branch un-gated, so anyone who owns a deal in an office still appears in THAT office
-- whatever this column says. The flag therefore only has to answer for people with no deals at all.
--
-- So the classification is simply: role='rep' -> true, everyone else -> false. At deploy that admits
-- exactly the old predicate's population, office by office, and it does so WITHOUT reading tenant data.
--
-- An earlier draft flagged deal owners true by scanning every office_*.deals. That was subtly wrong in a
-- multi-office setup: `users` is GLOBAL, so "owns a deal in office B" would set one global flag and hand
-- the person visibility in office A too, whose roster previously turned on office A's deals alone. The
-- un-gated owner branch expresses ownership where it actually lives -- per tenant -- and this column stays
-- a statement about the PERSON, which is what it claims to be.
--
-- It does not clean the roster by itself. The estimators/managers to be removed carry role='rep' for CRM
-- access and are left `true` here, to be unticked in the UI. This file makes the cleanup possible and
-- auditable; it does not perform it silently. Nor does it put anyone new on the dashboard: a director
-- with no deals yet stays invisible until an admin ticks them, which is the toggle's intended first use.
--
-- SCOPE: ROSTERS ONLY, NEVER A MONEY TOTAL. Read by the four director-dashboard ROSTER queries in
-- server/src/modules/dashboard/service.ts (buildRepPerformanceCards, getDirectorFunnelSummary,
-- getRepPerformanceSnapshots, getDirectorRepCommissionRows). Deliberately NOT read by
-- getCommissionOfficeTotals or getOverrideEarnedCommission, which compute MONEY -- a roster-hygiene flag
-- must never move a financial figure (the boundary migration 0142 drew for is_test_data). Where the two
-- meet, the flag is OR'd with evidence -- an earned commission row OR involvement on a live deal -- so
-- unticking someone can neither hide commission they hold nor strand value in the footer with no row
-- to explain it.
--
-- `users` is a single SHARED (non-tenant) table, so this is a plain ALTER: no per-tenant office_* loop
-- and no provisioner replay block.

-- CLASSIFY EXACTLY ONCE, KEYED ON THE SCHEMA, NOT ON THE DATA.
--
-- An earlier draft guarded the replay with "does any user already have generates_sales = false?". That
-- reads the wrong thing: an organisation where an admin has deliberately ticked EVERY non-rep on (or one
-- that only ever contained reps) legitimately has no false rows at all, so a hand replay against a
-- restored dump would sail past the guard and reset every non-rep to false -- silently undoing exactly
-- the admin decisions the guard exists to protect. Whether the classification has run is a fact about the
-- SCHEMA, so the column's own existence is what decides it.
--
-- The runner already skips executed files via public._migrations; this makes a manual replay safe too.
DO $$
DECLARE
  column_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'generates_sales'
  ) INTO column_existed;

  IF column_existed THEN
    RAISE NOTICE '0219: generates_sales already exists; leaving every value as the admins left it.';
    RETURN;
  END IF;

  ALTER TABLE public.users
    ADD COLUMN generates_sales boolean NOT NULL DEFAULT true;

  -- The one and only classification. role='rep' -> true, everyone else -> false; ownership is handled
  -- per tenant by the roster predicate's own un-gated owner branch, so it plays no part here.
  UPDATE public.users SET generates_sales = false WHERE role <> 'rep';
END $$;

COMMENT ON COLUMN public.users.generates_sales IS
  'Roster flag: is this person expected to carry deals? Gates the director-dashboard rosters only -- never a money total, and never overrides deal ownership. Orthogonal to users.role (access) by design. Migration 0219.';
