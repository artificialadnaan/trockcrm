# DD Email Notification Discovery

Date: 2026-05-11
Branch: `fix/dd-needed-email-notification`
Worktree: `/Users/adnaaniqbal/projects/trockcrm-dd-email`

## Scope

Investigated why new-company lead due diligence rows are created in the admin DD queue but admin notification emails are not sent.

## DD Queue Creation Path

- New lead creation enters `server/src/modules/leads/routes.ts` via `POST /api/leads`.
- The route calls `createLead` in `server/src/modules/leads/service.ts`.
- `createLead` computes whether the company/contact/property has recent 12-month activity via `isExistingCustomer`.
- For no recent activity, the lead stays in `new_lead`, sets `verificationStatus = "pending"`, and calls `createLeadDueDiligenceApproval`.
- `createLeadDueDiligenceApproval` inserts the pending row in `lead_due_diligence_approvals`; it intentionally does not send email inside the creation transaction.

## Email Dispatch Path

- After the lead transaction commits, `server/src/modules/leads/routes.ts` schedules `dispatchDueDiligenceEmailAfterCommit` with `setImmediate`.
- That helper opens a new DB transaction, sets the tenant search path, and calls `dispatchPendingDueDiligenceEmail`.
- `dispatchPendingDueDiligenceEmail` loads the pending approval, resolves recipients with `getLeadDueDiligenceRecipients`, builds the template with `buildLeadDueDiligenceEmail`, and sends through `sendSystemEmailWithMetadata` in `server/src/lib/resend-client.ts`.
- On success it writes `email_sent_at` and `email_message_id`. On send failure it returns false and leaves the queue row intact.

## Root Cause

The email send code exists and is wired from the normal `POST /api/leads` path. The failure condition is recipient resolution.

Before this fix, `getLeadDueDiligenceRecipients` only returned users explicitly assigned to the public `lead_due_diligence` notification recipient group. If that group was empty, stale, or seeded against emails that did not match production users, `dispatchPendingDueDiligenceEmail` logged:

`[lead-dd] pending due diligence approval <id> has no configured recipients`

and skipped Resend entirely.

This matches the observed behavior: the DD queue row is created, but admins receive no email.

## Recipient Findings

- A configurable DD reviewer group exists in `public.notification_recipient_groups` with key `lead_due_diligence`.
- Assignments live in `public.notification_recipient_assignments`.
- Admin UI endpoints exist:
  - `GET /api/admin/notification-recipient-groups/:key`
  - `PUT /api/admin/notification-recipient-groups/:key/assignments`
- Migration `0079_notification_recipient_groups.sql` seeded the DD group only when specific users already existed.
- Migration `0081_lead_dd_recipient_seed_correction.sql` corrected the same seed list, but the group can still be empty in an environment where those exact users are absent.

## Email Provider Config

- System email uses Resend through `server/src/lib/resend-client.ts`.
- Relevant env vars from `.env.example`:
  - `RESEND_API_KEY`
  - `RESEND_FROM_ADDRESS`
  - `EMAIL_OVERRIDE_RECIPIENT`
  - `SYSTEM_NOTIFICATION_EMAIL_OVERRIDE_ADDRESS`
  - `COMPANY_VERIFICATION_EMAIL`
- If `RESEND_API_KEY` is absent, the client logs `[Email:dev] Would send email:` and returns success for local/dev.
- If `EMAIL_OVERRIDE_RECIPIENT` is set, all mail is rerouted to that address with original recipients preserved in the subject/body.
- I did not read Railway production env values, per instruction.

## Fix Applied

`getLeadDueDiligenceRecipients` now preserves the configured DD reviewer group as the first source of truth. If the default `lead_due_diligence` group returns no active assigned users, it falls back to all active `admin` and `director` users.

This keeps explicit DD reviewer configuration intact while preventing silent no-recipient skips in production.

## Test Coverage Added

- DD recipient resolution falls back to active admins/directors when the DD recipient group is empty.
- `POST /api/leads` dispatches the DD email after a pending new-company lead commits.
- `POST /api/leads` does not dispatch DD email for an existing-company lead.
- Existing coverage already verifies email send errors are logged and do not roll back or mutate pending DD approval metadata.
