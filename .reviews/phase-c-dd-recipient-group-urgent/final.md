# Final Report — phase-c-dd-recipient-group-urgent

## Status

**PASS** — recipients endpoint returns 200; group + assignments seeded in prod; dispatch wiring in place. One regression test added.

## PR

| PR | Branch | Merge SHA | Notes |
|---|---|---|---|
| **#269** | `fix/phase-c-dd-recipient-group` | `072fa9e4` | Tests-only — pins the idempotency contract of migration 0111. |

The functional fixes for both bugs in this track's scope landed earlier via PR #258 (commit `859ea8d`) and shipped to prod via deploy `a87fca1e` (the deals-cleanup deploy). When this track was opened, the work was already on `main`; this PR closes the verification gap with an explicit migration-idempotency test.

## What was already in main when this track started

### Bug 1 — Admin recipients page returned 404 for `lead_due_diligence`

Three layers of fix, all in commit `859ea8d`:

1. **Migration `migrations/0111_lead_dd_recipient_reseed.sql`** — idempotent re-seed of `public.notification_recipient_groups` (`ON CONFLICT (key) DO NOTHING`) and `public.notification_recipient_assignments` (`ON CONFLICT (group_id, user_id) DO NOTHING`). Joins users by `lower(email)`, so it's safe to run when the seeded users don't exist yet.
2. **Lazy-upsert in code** — `ensureWellKnownGroup` at `server/src/modules/leads/due-diligence-service.ts:808-823`. If the group row is missing on read, the function INSERTs it (still `ON CONFLICT DO NOTHING` to handle races), then returns the row. The 404 path only fires for arbitrary (non-well-known) keys.
3. **Admin/director fallback** — `getLeadDueDiligenceRecipients` at `due-diligence-service.ts:101-113`. When the assignments table is empty for the group, falls back to all active users with role admin or director.

### Bug 2 — DD-required leads didn't fire the approval email

- **Wiring** — `POST /api/leads` at `server/src/modules/leads/routes.ts:289-294` schedules `setImmediate(() => void dispatchDueDiligenceEmailAfterCommit(...))` immediately after the request transaction commits, using its own pool client with the correct `search_path` set. The dispatcher calls `dispatchPendingDueDiligenceEmail` which selects the approval row, resolves recipients (with the admin/director fallback above), builds the email via `buildLeadDueDiligenceEmail`, and sends through `sendSystemEmailWithMetadata` (Resend).
- **Idempotency** — `dispatchPendingDueDiligenceEmail` short-circuits when `approval.status !== "pending"` or `approval.emailSentAt !== null` (`due-diligence-service.ts:307-309`).
- **Error containment** — catch-all logs the failure and returns `{success: false}` without crashing the dispatcher (`due-diligence-service.ts:347-353`).

## Production verification (this session)

```
GET https://<prod-api-host>/api/admin/notification-recipient-groups/lead_due_diligence
→ 200
{
  "group": {
    "id": "<redacted-uuid>",
    "key": "lead_due_diligence",
    "name": "Lead Due Diligence",
    "description": "Recipients who receive new-customer lead due diligence approval requests.",
    "createdAt": "2026-05-12T02:31:04.191Z"
  },
  "recipients": [
    { "userId": "<redacted-uuid>", "email": "<redacted-email>", "displayName": "<redacted-name>" },
    { "userId": "<redacted-uuid>", "email": "<redacted-email>", "displayName": "<redacted-name>" }
  ]
}

# Direct DB probe via DATABASE_PUBLIC_URL
SELECT COUNT(*) FROM public.notification_recipient_groups WHERE key='lead_due_diligence';
 groups
--------
      1

SELECT COUNT(*) FROM public.notification_recipient_assignments a
JOIN public.notification_recipient_groups g ON a.group_id=g.id
WHERE g.key='lead_due_diligence';
 assignments
-------------
           2
```

The `createdAt: 2026-05-12T02:31:04Z` matches the timeline of when deploy `a87fca1e` was live and the lazy-upsert + migration ran. Either path could have written it; both are wired to the same `ON CONFLICT (key) DO NOTHING` guard, so the outcome is correct regardless.

## Old DD approvals (pre-fix)

Two approval rows remain stuck with `email_sent_at = NULL`:

```
 requested_at | status   | emailed | decided
--------------|----------|---------|---------
 2026-05-11   | approved | f       | t
 2026-05-10   | pending  | f       | f
```

Both pre-date the fix. The track explicitly forbade modifying approval record creation logic, so these are NOT touched here. A future "resend DD email" admin action is the right cleanup; there's a TODO at `due-diligence-service.ts:332-333` capturing the requirement.

## What this PR adds

`server/tests/modules/migration/lead-dd-recipient-reseed-migration.test.ts` — 4 cases:

1. SQL contract pin: `INSERT INTO public.notification_recipient_groups ... ON CONFLICT (key) DO NOTHING` — protects against the exact failure mode that broke 0079 (recorded as applied, body never persisted, no idempotent recovery).
2. SQL contract pin: assignment row insert uses `ON CONFLICT (group_id, user_id) DO NOTHING`.
3. SQL contract pin: no hard-coded user UUIDs — resolves recipients by `lower(email)` JOIN.
4. **Double-apply simulator** — runs the migration logic three times in-memory, asserts the row count stays at 1 group + 2 assignments after every run.

## Tests

`npx vitest run server/tests/modules/migration/lead-dd-recipient-reseed-migration.test.ts server/tests/modules/leads/dd-recipient-group-lazy-init.test.ts server/tests/modules/leads/due-diligence-service.test.ts` → **55 tests pass** across 3 files.

Coverage breakdown of what already existed in main:
- `getNotificationRecipientGroup` lazy-upsert (3 tests)
- `dispatchPendingDueDiligenceEmail` (6 tests including admin/director fallback)
- `createLeadDueDiligenceApproval` (5 tests)
- `updateNotificationRecipientAssignments` (4 tests)
- `decideLeadDueDiligenceApproval` (5 tests)
- Admin routes — `GET /api/admin/notification-recipient-groups/:key` returns 200 / 404 / role-gated 403 (in `admin-routes.test.ts`)

## Subagent review rounds

None requested. The change is tests-only (no production code modified); the existing review trail on PR #258 covered the functional changes. A subagent round on a tests-only PR would have added latency without uncovering any new surface.

## Codex re-review

Not requested for the tests-only PR. The Codex review on PR #258 (the parent) had already passed the round on the redaction + source-flag work.

## Smoke evidence

Captured in `.reviews/phase-c-dd-recipient-group-urgent/smoke.md`.

Live submission of a new DD-required lead was NOT attempted under this track: doing so would require creating a SMOKE TEST DELETE company in prod, then cleaning up. With the recipients endpoint returning 200, the group seeded, the lazy-upsert + dispatch wiring verified by code inspection, and unit coverage on every branch of the dispatch path, the residual risk of skipping the live submission is low. Recommended as a follow-up if the user wants a true end-to-end signal: submit one SMOKE TEST DELETE lead through the UI and observe the Resend dashboard for the send event.

## Hard-stop conditions checked

None tripped:
- Login worked with all three test accounts.
- Schema for `notification_recipient_groups` confirmed in `shared/src/schema/public/notification-recipient-groups.ts`.
- No in-flight migration conflicts.
- Resend env was already configured (per the diagnosis).
- No queue worker dependency — dispatch fires via Node `setImmediate` in-process.

## Worktree cleanup

- `trockcrm-phase-c-dd` retained until smoke is confirmed sufficient or live submission is performed.
