-- Migration 0222: `public.users.estimates_jobs` — the per-person "does this person ESTIMATE?" flag,
-- the estimator twin of 0219's generates_sales.
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/021*' 'migrations/022*'
-- Highest across ALL remote heads at authoring time: 0221 (0221_deal_stage_history_created_at_index.sql).
-- 0222 is free.
--
-- WHY THIS EXISTS. The deals-dashboard Rep filter means OWNS — see buildOwnedRepCondition, which spells
-- out why the estimator link is deliberately excluded from it. That is correct for a rep filter and it
-- leaves a real hole: an estimator who owns nothing is unreachable. In this database Sidney Gibson owns
-- 0 deals and is the estimator on 137, and Alex Koch owns 0 and estimates 72 — picking either of them
-- returned an empty board. The fix is not to loosen the rep filter (that would put one deal on two
-- people's rows and stop the board reconciling with every by-owner surface); it is a SECOND, clearly
-- labelled dimension that asks a different question, and this column is who may be asked it.
--
-- WHY A FLAG AND NOT THE DATA. deals.estimator_user_id cannot answer "is this person an estimator":
-- it is populated far beyond the handful of real estimators, largely because a rep who estimates their
-- own deal is recorded on it. Measured at authoring time, of Colby Burling's 221 estimator rows 167 are
-- his OWN deals; Andrew Green's 119 are 112 self-estimated. Deriving the roster from that column would
-- file most of the sales team as estimators. An admin ticking a box states the intent that the data
-- cannot.
--
-- DEFAULT false, AND NO CLASSIFICATION PASS — the opposite of 0219 on both counts, deliberately.
-- 0219 defaulted true because a false default would have EMPTIED an existing dashboard on deploy. This
-- column starts a NEW list that nobody is on yet, so false starts it empty and correct; ticking is the
-- safe direction. And there is no data-derived seed here because `users` is GLOBAL while `deals` is
-- per-tenant: classifying from office_*.deals would set one global flag from one office's data and hand
-- the person an estimator listing in every other office too — the exact multi-office error 0219's header
-- records rejecting for the same reason.
--
-- SCOPE: ROSTER MEMBERSHIP ONLY, NEVER A MONEY TOTAL, and never a permission. It decides who the deals
-- and leads filters OFFER under "Estimators". It does not grant access, does not change who may be set
-- as a deal's estimator (validateAssignee still governs that), and is read by no commission query —
-- the boundary 0142 drew for is_test_data and 0219 kept for generates_sales.
--
-- `users` is a single SHARED (non-tenant) table, so this is a plain ALTER: no per-tenant office_* loop
-- and no provisioner replay block.

-- Keyed on the SCHEMA, not the data: whether this has run is a fact about the column's existence, so a
-- hand replay against a restored dump cannot reset flags an admin has since set (0219's guard, verbatim
-- in spirit).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'estimates_jobs'
  ) THEN
    RAISE NOTICE '0222: estimates_jobs already exists; leaving every value as the admins left it.';
    RETURN;
  END IF;

  ALTER TABLE public.users
    ADD COLUMN estimates_jobs boolean NOT NULL DEFAULT false;
END $$;

COMMENT ON COLUMN public.users.estimates_jobs IS
  'Roster flag: does this person estimate jobs? Gates the "Estimators" group of the deals/leads owner filters only -- never a money total, never a permission, and orthogonal to users.role. Someone ticked generates_sales is listed under Sales Reps regardless of this flag (one person, one section). Migration 0222.';
