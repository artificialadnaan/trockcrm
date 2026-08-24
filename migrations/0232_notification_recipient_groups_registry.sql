-- Seed the group rows for the two keys added to NOTIFICATION_RECIPIENT_GROUPS
-- (shared/src/types/notification-recipient-groups.ts).
--
-- The rows are created lazily today: `ensureWellKnownGroup` upserts one the first time an admin OPENS
-- /admin/notification-recipients. That is fine for the page, which creates what it needs, and wrong for
-- everything else — until somebody visits, the key has no row at all, so a job reading its recipients
-- cannot tell "nobody has configured this yet" from "an admin configured it to nobody". Both come back as
-- an empty list, and an empty list is exactly the silent failure the resolver work in this PR exists to
-- stop. Seeding here means the row is true at deploy time rather than at first click.
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
