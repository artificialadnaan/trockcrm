-- Migration 0236: the Wednesday estimating bid-due-date report — its recipient groups and its
-- exactly-once receipt ledger.
--
-- NUMBERING PROVENANCE (0216's header explains why "highest number on disk" is the wrong test):
--   git fetch origin --prune
--   git log --all --diff-filter=AM --name-only --format= -- 'migrations/022*' 'migrations/023*'
-- Highest across ALL remote heads at authoring time: 0233 (0233_task_source_classification.sql, on an
-- unmerged branch; 0231 is the highest on main). 0232, 0234 and 0235 are claimed by sibling PRs in
-- flight. 0236 is free.
--
-- NO TENANT LOOP AND NO PROVISIONER REPLAY BLOCK, deliberately, and this is the part worth checking
-- rather than assuming. Every object below lives in `public`:
--   * notification_recipient_groups / _assignments are public because `users` is public (0079's own
--     header says so) — a recipient group is a set of people, and people are global here;
--   * the receipt ledger is keyed BY tenant_schema as a COLUMN, the shape all five existing receipt
--     ledgers use (rfp_rejection_email_receipts, 0148). One table, one row per office per week.
-- So there is nothing for a `DO $tenant$` loop to walk and nothing a new office needs replayed into its
-- schema. A new office is covered the moment it exists, because the worker walks public.offices.
--
-- ============================================================================================
-- THE SEED WARNS — IT DOES NOT RAISE — WHEN IT MATCHES NOBODY. Read this before "fixing" it.
-- ============================================================================================
-- `notification_recipient_groups` seeds are conditional joins against `public.users` with ON CONFLICT DO
-- NOTHING (0079:39-45), which means a seed that matches no user is a SILENT no-op. That is survivable for
-- Lead Due Diligence, whose resolver falls back to every active admin and director. This group has no
-- fallback — deliberately, because a report meant for one estimator is not improved by going to all of
-- leadership — so an empty group means the report resolves to NOBODY.
--
-- THIS WAS WRITTEN AS `RAISE EXCEPTION` FIRST, AND THAT WAS WRONG. The next person to read this will think
-- a silent empty group deserves to be loud, so here is the argument against, in full:
--
--   * The Dockerfile CMD is `node server/dist/migrations/runner.js && node server/dist/index.js`, and the
--     runner calls process.exit(1) on any failure. A raising migration therefore does not merely fail a
--     deploy — the API container never reaches its start command, so it CRASH-LOOPS and the CRM goes down.
--   * What that buys is nothing the platform does not already have. runBidDueDateReport treats an empty
--     recipient list as a hard error: logger.error + throw, before the send, no receipt written. The case
--     IS caught loudly. The only difference is worker logs a week later instead of deploy logs today.
--   * And this check cannot tell the two causes apart. "Sidney's user row genuinely is not there" and
--     "her email address changed" look identical from here, and the second is an ordinary Tuesday. Both
--     would have taken the whole platform down.
--
-- A report that does not send for one week and a CRM that will not boot are not comparable blast radii.
-- The job-side throw is the guard of record; this WARNING is a deploy-time courtesy that makes the fix
-- available a week early to anyone reading the migration output.
--
-- IF IT WARNS, the fix is one statement — no migration edit, and this file is idempotent, so re-running
-- it after the insert succeeds:
--
--   INSERT INTO public.notification_recipient_assignments (group_id, user_id)
--   SELECT g.id, u.id
--     FROM public.notification_recipient_groups g, public.users u
--    WHERE g.key = 'bid_due_date_report'
--      AND u.email = '<the estimator''s actual address>';
--
-- WHY THE MATCH IS BY NAME **AND** EMAIL. The address this feature was specified against,
-- sidney@trockgc.com, appears NOWHERE in production source — only in two test fixtures — so seeding on it
-- alone would be seeding on a guess. `display_name` is the identity migration 0222's header actually
-- records for this person ("Sidney Gibson owns 0 deals and is the estimator on 137"), so both are tried
-- and either is enough.

-- A CLAIM ledger, not a send log — the 0174 protocol (rfp_pending_sla_email_receipts).
--
-- The row is INSERTed before the provider is called and STAMPED after, because the three send outcomes are
-- not two. `delivered` stamps sent_at. `rejected` means the provider refused and created nothing, so the
-- claim is DELETED and the next tick retries. `unknown` — which is what resend@6 reports for a socket
-- hang-up, a 5xx or a gateway timeout, since it wraps its whole fetch in a try/catch — means the message
-- MAY ALREADY BE IN THE INBOX, so the claim STAYS, unstamped, and the next tick declines rather than
-- risking a duplicate.
--
-- That distinction is only consequential because this job has a Thursday catch-up tick. Without it an
-- ambiguous failure simply waited until next Wednesday; with it, the provider would be called again 24
-- hours later for a message that may well have gone out. (Resend's own idempotency key is NOT the backstop
-- here: its window is 24 hours, which is exactly the Wednesday-to-Thursday gap, so it is the one interval
-- it cannot be relied on for.)
--
-- The cost of claim-first is the mirror image and is accepted deliberately: a crash between the claim and
-- the send leaves an unstamped row and that week is not sent. `sent_at IS NULL` makes those visible --
--   SELECT * FROM public.bid_due_date_report_receipts WHERE sent_at IS NULL;
-- -- and deleting such a row re-arms the week. For a report to one estimator, a week that needs a nudge
-- beats a duplicate nobody asked for.
CREATE TABLE IF NOT EXISTS public.bid_due_date_report_receipts (
  tenant_schema text NOT NULL,
  -- The WEDNESDAY the report covers, resolved BACKWARD from the run date, so the Thursday catch-up tick
  -- lands on the same key and reads the claim instead of sending a second copy.
  week_of date NOT NULL,
  recipient_emails text,
  resend_message_id text,
  deal_count integer,
  -- NULLABLE, no default: the row is a CLAIM at insert and is stamped only after a DELIVERED send. NULL
  -- means "we asked, and never learned the answer" — never "not sent".
  sent_at timestamptz,
  -- The outcome that left this row unstamped, for an operator deciding whether to re-arm the week.
  outcome text,
  claimed_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_schema, week_of)
);

-- The ledger is read by exactly one query — the week's receipt for one office — which the primary key
-- already serves. The one other question anybody asks of it ("when did this office last get its report")
-- is a small scan of one office's rows; no second index earns its write cost here.

INSERT INTO public.notification_recipient_groups (key, name, description)
VALUES
  (
    'bid_due_date_report',
    'Bid Due Date Report',
    'Recipients who receive the weekly Wednesday estimating report of upcoming bid due dates.'
  ),
  (
    'bid_due_date_report_cc',
    'Bid Due Date Report (Cc)',
    'Copied on the weekly Wednesday estimating report of upcoming bid due dates.'
  )
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- TO: the estimator the report is written for.
INSERT INTO public.notification_recipient_assignments (group_id, user_id)
SELECT g.id, u.id
FROM public.notification_recipient_groups g
JOIN public.users u
  ON lower(u.email) = 'sidney@trockgc.com'
  OR lower(btrim(COALESCE(u.display_name, ''))) = 'sidney gibson'
WHERE g.key = 'bid_due_date_report'
  AND u.is_active = true
ON CONFLICT (group_id, user_id) DO NOTHING;

-- CC: oversight. Seeded by the ONE address this database is known to carry — 0079 seeded the Lead Due
-- Diligence group with it and that group has been resolving to a real person ever since, which is the
-- closest thing to a verified user id available from source.
INSERT INTO public.notification_recipient_assignments (group_id, user_id)
SELECT g.id, u.id
FROM public.notification_recipient_groups g
JOIN public.users u
  ON lower(u.email) = 'adnaan.iqbal@gmail.com'
WHERE g.key = 'bid_due_date_report_cc'
  AND u.is_active = true
ON CONFLICT (group_id, user_id) DO NOTHING;

DO $seed_check$
DECLARE
  v_recipients integer;
  v_cc integer;
BEGIN
  SELECT COUNT(*) INTO v_recipients
    FROM public.notification_recipient_groups g
    JOIN public.notification_recipient_assignments a ON a.group_id = g.id
    JOIN public.users u ON u.id = a.user_id
   WHERE g.key = 'bid_due_date_report'
     AND u.is_active = true;

  -- WARNING, NOT EXCEPTION — see the header. A raise here crash-loops the API container, and the job
  -- already refuses to send on an empty list, so raising costs the platform and buys a week's notice.
  IF v_recipients = 0 THEN
    RAISE WARNING
      'Migration 0236: the "bid_due_date_report" group matched no ACTIVE user, so the weekly bid due date report will refuse to send (runBidDueDateReport throws on an empty recipient list) until somebody is assigned. This group has NO admin/director fallback by design. Assign a recipient — this migration is idempotent and need not be re-run. See the header of migrations/0236_bid_due_date_report.sql for the one-line INSERT.';
  END IF;

  -- The CC list is oversight, not audience: an empty one is a choice an admin is allowed to make, and the
  -- worker sends anyway rather than throwing. Both branches warn, but for DIFFERENT reasons — the one above
  -- because raising is too expensive, this one because there is no fault to report at all.
  SELECT COUNT(*) INTO v_cc
    FROM public.notification_recipient_groups g
    JOIN public.notification_recipient_assignments a ON a.group_id = g.id
    JOIN public.users u ON u.id = a.user_id
   WHERE g.key = 'bid_due_date_report_cc'
     AND u.is_active = true;

  IF v_cc = 0 THEN
    RAISE WARNING
      'Migration 0236: the "bid_due_date_report_cc" group matched no ACTIVE user. The report will still be sent; nobody will be copied. Add recipients on the admin Notification Recipients page.';
  END IF;
END
$seed_check$;
