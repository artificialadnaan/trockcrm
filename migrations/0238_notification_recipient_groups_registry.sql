-- Migration 0238: seed the group rows for the two keys added to NOTIFICATION_RECIPIENT_GROUPS
-- (shared/src/types/notification-recipient-groups.ts).
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/023*'
-- Highest number MERGED at authoring time: 0231 (0231_weekly_report_views.sql). 0232 was therefore free on
-- disk and is NOT free in fact — 0232 through 0237 are taken by branches stacked on this one that have not
-- landed yet, and every one of them would have collided with a file numbered from this checkout alone:
--   0232  marketing expense requests   (#1106, feat/marketing-expense-request)
--   0233  task source
--   0234  task comments
--   0235  task ack
--   0236  bid-due report
--   0237  task index
-- This file was authored as 0232 and renumbered to 0238 once the stack was known. It is the newest of the
-- set and nothing depends on its position, which made it the cheapest one to move.
--
-- ORDERING AGAINST #1106. That branch's 0232 also creates the `marketing_expense_approver` row, with the
-- same name and description (both are transcribed from the same registry entry) and `ON CONFLICT DO
-- NOTHING`, plus an assignment row this file does not touch. At 0238 this runs AFTER it in a merged tree,
-- and the DO UPDATE below then rewrites that row with values identical to the ones already there. The
-- reverse order is reachable too — a database that has already run 0238 gets 0232 on the deploy that
-- merges #1106, because the runner keys on the full filename and skips only what it has executed — and
-- their DO NOTHING leaves this file's row alone. Both orders converge, and both are verified by
-- server/tests/modules/leads/notification-recipient-groups.test.ts against a real Postgres.
--
-- The `marketing_expense_approver` row is seeded here as well as there deliberately: this PR is the BASE
-- of that stack and can land without it, and the registry is not allowed to name a key no migration
-- creates.
--
-- WHY SEED AT ALL. The rows are created lazily today: `ensureWellKnownGroup` upserts one the first time an
-- admin OPENS /admin/notification-recipients. That is fine for the page, which creates what it needs, and
-- wrong for everything else — until somebody visits, the key has no row at all, so a job reading its
-- recipients cannot tell "nobody has configured this yet" from "an admin configured it to nobody". Both
-- come back as an empty list, and an empty list is exactly the silent failure the resolver work in this PR
-- exists to stop. Seeding here means the row is true at deploy time rather than at first click.
--
-- Assignments are deliberately NOT seeded. Who receives these is the decision of the PRs that ship the
-- features, and guessing here would put mail in someone's inbox that nobody asked for. Both keys have
-- their admin/director fallback OFF, so an unassigned group resolves to nobody rather than to leadership.
--
-- Global, not per-office: `notification_recipient_groups` lives in `public` because `users` does (0079).

INSERT INTO public.notification_recipient_groups (key, name, description)
VALUES
  (
    'bid_due_date_report',
    'Bid Due Date Report',
    'Recipients of the weekly Wednesday estimating report of upcoming bid due dates.'
  ),
  (
    'marketing_expense_approver',
    'Marketing Expense Approver',
    'Approves marketing and advertising expense requests.'
  )
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;
