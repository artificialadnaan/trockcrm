# Christy Project Number Email

## Investigation Findings

### Project-number field

- Deal project number is `deals.projectNumber` in Drizzle, backed by the tenant table column `project_number`.
- Definition: `text("project_number")` in `shared/src/schema/tenant/deals.ts`; it is nullable/blank-capable.
- There is a partial unique index for non-null project numbers: `deals_project_number_uidx`.
- No existing audit/history row specifically represented "project number first set"; this change adds a dedicated `audit_log` row for that event.

### Write paths

The write-path inventory found the following code paths that can write `project_number`:

- `server/src/modules/deals/service.ts`
  - `createDeal` and `updateDeal` now accept/forward `projectNumber`.
  - These API/service writes are covered by the database trigger.
- `scripts/backfill-project-numbers.ts`
  - Bulk project-number backfill.
  - Updated to support `SKIP_PROJECT_NUMBER_EMAIL=true` through the transaction-local DB skip flag.
- `scripts/hubspot-deals-reimport.ts`
  - Bulk HubSpot re-import path that writes project numbers.
  - Updated to support `SKIP_PROJECT_NUMBER_EMAIL=true`.
- `scripts/normalize-project-number-case.ts`
  - Updates existing project numbers, not first-set events, but updated to support the skip flag defensively.
- `scripts/create-bidboard-excluded-real-projects.js`
  - Bulk creates deals with `project_number` already populated.
  - Updated to set the transaction-local skip flag before inserts.

The SyncHub/procore project relay paths use project-number values for matching and portfolio project records but do not directly set the deal `project_number` column. The internal RFP editor maps its `projectNumber` input to `deal_number`, not the deal `project_number` column.

### Email infrastructure

- Existing transactional email provider is Resend.
- Server-side email code lives around `server/src/lib/resend-client.ts` and notification email delivery uses `server/src/modules/notifications/email-delivery.ts`.
- The worker did not previously have a small system-email wrapper, so this change adds `worker/src/lib/system-email.ts`, using the same Resend provider and existing env conventions:
  - `RESEND_API_KEY`
  - `RESEND_FROM_ADDRESS`
  - `EMAIL_OVERRIDE_RECIPIENT`
- No new email provider was introduced.

### Audit mechanism

- Tenant `audit_log` is the richer audit table. It supports nullable `changed_by`, `actor_system_process`, `entity_type`, `entity_name_snapshot`, `field_changes_jsonb`, `changes`, and `visibility_scope`.
- `deal_history` exists, but it requires a non-null user-oriented `changed_by` shape and is less suitable for DB-triggered system events.
- This feature records `actor_system_process = 'project_number_first_set'` in tenant `audit_log` and uses that row as the first-set idempotency source.

## Implementation Strategy

- Added migration `0138_project_number_first_set_notification.sql`.
- The migration installs `public.enqueue_project_number_first_set_email()` and a tenant trigger:
  - `AFTER INSERT OR UPDATE OF project_number ON <tenant>.deals`
  - fires only when the new value is nonblank and the old value was blank/null.
  - does not fire for edits of an already-set project number.
  - respects `app.skip_project_number_email` for bulk scripts.
- The trigger inserts one tenant `audit_log` event with `actor_system_process = 'project_number_first_set'`.
- A partial unique index on tenant `audit_log(record_id)` for that system process prevents a second first-set event for the same deal.
- If the audit row is newly inserted, the trigger enqueues a `public.job_queue` job: `project_number_first_set_email`.
- The trigger catches/logs its own failures so the deal write itself is not rolled back by email/audit enqueue failures.

## Worker Email

- Added worker job handler `project_number_first_set_email`.
- The handler loads the deal from the tenant schema, including:
  - deal name
  - project number
  - assigned rep display/full name/email fallback
  - awarded amount from `awarded_amount`
- Email subject:
  - `New project number assigned: {projectNumber} ({dealName})`
- Email body includes:
  - Deal name
  - Project number
  - Sales rep
  - Awarded amount formatted as USD
  - CRM deal link (`FRONTEND_URL` or production CRM fallback plus `/deals/{dealId}`)
- Recipient:
  - `CHRISTY_PROJECT_NUMBER_EMAIL`
  - non-production fallback: `kscheidegger@trockgc.com`
  - production missing recipient is treated as a retryable worker failure, not a completed lost notification.
- Visible CC:
  - `PROJECT_NUMBER_EMAIL_CC`
  - non-production fallback: `adnaan.iqbal@gmail.com`
  - production missing/empty CC is logged and omitted; the email still sends to Christy.
  - single-address shape only, no CSV/list parsing.
  - sent in the same Resend call via the existing `cc` option, not as a second email.

## Idempotency

- First-set idempotency source: tenant `audit_log` row with `actor_system_process = 'project_number_first_set'`.
- Duplicate job enqueue is prevented by the audit-log partial unique index plus `ON CONFLICT DO NOTHING`.
- Worker retry duplicate-send protection:
  - added `public.project_number_first_set_email_receipts`, keyed by `audit_log_id`.
  - worker checks this receipt before sending.
  - worker records the receipt after successful send.
  - Resend is called with idempotency key `project-number-first-set-{auditLogId}` to protect the crash-after-send/before-receipt edge as much as the provider supports.
- Adding the CC does not alter audit/idempotency behavior: one first-set audit event still maps to one worker email job and one provider send call.

## Bulk Script Skip Mechanism

- Added `scripts/lib/project-number-notification.ts`.
- Scripts can call `applyProjectNumberEmailSkipSetting()` after `BEGIN`, which sets:
  - `app.skip_project_number_email = true` transaction-locally.
- Updated existing project-number bulk scripts:
  - `scripts/backfill-project-numbers.ts`
  - `scripts/hubspot-deals-reimport.ts`
  - `scripts/normalize-project-number-case.ts`
  - `scripts/create-bidboard-excluded-real-projects.js`
- Future project-number seed scripts, including the planned `dealCleanUpMaster.xlsx` seed, must explicitly use `SKIP_PROJECT_NUMBER_EMAIL=true` or the same transaction-local skip setting. Otherwise Christy would receive one notification per newly seeded project number.

## Review Rounds

- Round 1 found and fixed:
  - production worker missing `RESEND_API_KEY` could have completed jobs as "success"; now it returns unsuccessful and the job retries/fails rather than silently completing.
  - future office schemas needed trigger/index provisioning; the migration now includes tenant provisioning markers.
  - trigger-side enqueue/audit failures needed to be nonblocking; the trigger catches and warns.
  - rich audit shape was improved to use `field_changes_jsonb` plus `changes.projectNumber`.
- Round 2 found and fixed:
  - worker retry could duplicate-send after a successful provider call; added receipt ledger and Resend idempotency key.
  - `create-bidboard-excluded-real-projects.js` could bulk-create project numbers without the skip flag; it now opts out.
  - production missing `CHRISTY_PROJECT_NUMBER_EMAIL` could have become a completed/lost notification; it now retries instead of completing.
- CC follow-up review found no issues:
  - `PROJECT_NUMBER_EMAIL_CC` follows the same env/default shape as Christy's recipient.
  - unset production CC does not block the To send.
  - Resend receives one send call with `cc` when configured.
  - trigger, audit, migration, bulk skip, and idempotency behavior remain unchanged.

## Verification

Passed:

- `npm run build --workspace=shared`
- `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/project-number-first-set-email.test.ts server/tests/scripts/project-number-notification-skip.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
- `npm run typecheck --workspace=server`
- `npm run typecheck --workspace=worker`
- `npm run typecheck --workspace=shared`
- `npm run build --workspace=shared`
- `npm run build --workspace=server`
- `npm run build --workspace=worker`
- `npm run typecheck --workspace=client`
- `npm run build --workspace=client`
- CC follow-up:
  - `npm run build --workspace=shared`
  - `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/project-number-first-set-email.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
  - `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/project-number-first-set-email.test.ts server/tests/scripts/project-number-notification-skip.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
  - `npm run typecheck --workspace=worker`
  - `npm run typecheck --workspace=server`
  - `npm run typecheck --workspace=shared`
  - `npm run build --workspace=shared`
  - `npm run build --workspace=worker`
  - `npm run build --workspace=server`

CC tests cover:

- configured `PROJECT_NUMBER_EMAIL_CC` is passed as a visible `cc` option.
- unset production `PROJECT_NUMBER_EMAIL_CC` logs and sends to Christy without CC.
- the CC comes from the env var, with non-production default `adnaan.iqbal@gmail.com`.
- duplicate prevention remains one email send for the audit event, not one send per recipient.

Requested broad test sweep:

- `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`
- Result: failed on the known sandbox `listen EPERM` auth/supertest failure, with broad cascade. This matches the documented unrelated pre-existing failure class and is not tied to this change.

## Deployment Note

The worker must deploy with the new `project_number_first_set_email` handler before or alongside the migration trigger. If an older worker polls the new job type before the handler exists, the existing queue logic can mark unknown job types dead.
