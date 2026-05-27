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
- The trigger now lets audit-log and job-queue failures raise normally. That rolls back the deal write, so a later API/script retry still has a blank-to-set transition and can enqueue the notification correctly.
- Operator-visible behavior: a transient audit/enqueue failure can surface as a failed deal write/API 500. This is intentional for this feature; it avoids silently committing the project number without a retryable notification path.
- Normal API deal writes now gate `projectNumber` mutations to admins/directors. Ordinary reps cannot set or clear `projectNumber` through `POST /deals`, `POST /deals/service-opportunity`, or `PATCH /deals/:id`, so ordinary deal edits cannot trigger Christy's email.

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
  - CRM deal link (`FRONTEND_URL` or production CRM fallback plus `/deals/{dealId}?officeId={officeId}`)
- Office context:
  - The worker resolves the tenant schema to the existing `public.offices.id`.
  - The email link includes that office id as `officeId`.
  - `DealDetailPage` reads `officeId` and passes it to `useDealDetail`.
  - `useDealDetail` uses the existing `getOfficeRequestOptions` / `x-office-id` convention, so the detail request resolves against the originating office instead of the viewer's default office.
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
  - added `public.project_number_first_set_email_receipts`, keyed by `(tenant_schema, audit_log_id)`.
  - worker checks this receipt using both tenant schema and audit log id before sending.
  - worker records the receipt after successful send using the composite conflict target.
  - Resend is called with idempotency key `project-number-first-set-{tenant_schema}-{auditLogId}` to protect the crash-after-send/before-receipt edge as much as the provider supports.
- The receipt migration drops the old single-column primary key and recreates the composite key. The feature has not deployed, so this is a clean correction before production receipts exist.
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
  - trigger-side enqueue/audit failures were initially made nonblocking, then superseded by the Codex fix round: they now raise and roll back the deal write to avoid silent notification loss.
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
- Codex fix review for commit `59f1020207` found no remaining code issues after the four fixes below:
  - receipt dedupe is tenant-aware.
  - trigger failures are no longer swallowed.
  - project-number API writes are restricted to admin/director requests.
  - email links carry existing office context through `officeId` and `x-office-id`.
  - Practical test gaps from review were addressed with additional route and hook tests; there is no live Postgres trigger harness in the repo, so the trigger rollback behavior is covered by migration assertions that the swallowing exception handler was removed.

## Verification

## Codex Re-Review Fix Round (`f2555621a9` follow-up)

### Finding 1: tenant-scoped receipts and provider idempotency

End-to-end trace verified:

- Trigger/job payload: `migrations/0138_project_number_first_set_notification.sql` enqueues `project_number_first_set_email` with `tenantSchema = TG_TABLE_SCHEMA`, `dealId`, `projectNumber`, and `auditLogId`.
- Receipt schema: `public.project_number_first_set_email_receipts` has `tenant_schema text NOT NULL`, `audit_log_id bigint NOT NULL`, and a composite `PRIMARY KEY (tenant_schema, audit_log_id)`. The migration explicitly drops the prior receipt primary key before adding the composite key.
- Worker lookup: `worker/src/jobs/project-number-email.ts` checks for a sent receipt with `WHERE tenant_schema = $1 AND audit_log_id = $2`.
- Worker insert: successful sends insert both `tenant_schema` and `audit_log_id`, using `ON CONFLICT (tenant_schema, audit_log_id) DO UPDATE`.
- Provider idempotency: Resend receives `project-number-first-set-{tenantSchema}-{auditLogId}`, so two offices with the same tenant-local audit id do not share a provider idempotency key.

Test coverage added/confirmed:

- The migration test now explicitly rejects a single-column `audit_log_id bigint PRIMARY KEY` receipt shape and asserts `PRIMARY KEY (tenant_schema, audit_log_id)`.
- The worker collision test sends two jobs with `auditLogId = 123`, one for `office_dallas` and one for `office_atlanta`; both emails send, their Resend idempotency keys differ, and the mocked receipt inserts contain two rows with distinct `tenant_schema` values.
- Trigger enqueue failure remains covered by migration assertions that the swallowing `EXCEPTION WHEN OTHERS` path is absent; an insert failure into `public.job_queue` now propagates and rolls back the deal write rather than silently committing a non-retryable project-number update.

### Finding 2: office context in the email deal link

End-to-end trace verified:

- Worker link builder resolves `tenant_schema` to `public.offices.id` and emits `FRONTEND_URL/deals/{dealId}?officeId={officeId}`.
- `DealDetailPage` reads `officeId` from the URL query string before calling `useDealDetail`.
- `useDealDetail` passes the office id through `getOfficeRequestOptions`, which sends `x-office-id` on the initial `/deals/{id}/detail` request.
- `server/src/middleware/auth.ts` validates that `x-office-id` is an accessible office and sets `req.user.activeOfficeId` to that requested office before `server/src/middleware/tenant.ts` resolves the tenant search path. This is the existing cross-office request mechanism; there is no separate persisted active-office switch endpoint for a detail URL.

Architectural decision:

- I kept the smallest route-safe mechanism: `?officeId=` on the deal URL plus the existing `x-office-id` API header. That loads the notified deal from the originating tenant without requiring the recipient to manually switch offices first, and it avoids a broader route/refetch/active-office state refactor.

Test coverage added/confirmed:

- The email body test asserts the deal URL contains `?officeId=office-dallas`.
- `useDealDetail` test asserts the hook sends `x-office-id` when office context is supplied.
- `DealDetailPage` test now asserts a URL like `/deals/deal-1?officeId=office-atlanta` passes `office-atlanta` into the initial detail hook call.

### Finding 3: project-number format validation

End-to-end trace verified:

- `scripts/backfill-project-numbers.ts` only backfills canonical values matching `/^(DFW|ATL)-[0-9]+-[0-9]{5}-[a-z]{2}$/`; non-canonical preserved values are skipped as `legacy format`.
- `scripts/normalize-project-number-case.ts` only normalizes an existing `dfw|atl` prefix to uppercase; it is not a broad acceptance path for arbitrary project-number text.
- `server/src/modules/deals/routes.ts` now applies the same canonical regex before `createDeal` / `updateDeal` writes can persist `projectNumber`.
- The API validator rejects non-string values, empty strings, whitespace-only strings, values over the app write cap, lowercase-prefix values such as `dfw-1-12345-aa`, and legacy/non-canonical strings. Valid values are trimmed before being passed to `updateDeal`.
- Admin/director authorization is unchanged; reps still cannot set or clear project numbers through normal deal APIs.

Column-size note:

- The tenant `deals.project_number` column is `text`, not `varchar`, so there is no database column max to reuse. The API uses `100`, matching the staging/import project-number field size, as the practical oversized-input guard.

Test coverage added:

- `PATCH /api/deals/:id` rejects `projectNumber: ""`, `"   "`, an oversized canonical-looking value, `dfw-1-12345-aa`, and `DFW-1-1234-aa` with `PROJECT_NUMBER_INVALID` before calling `updateDeal`.
- A trimmed valid value still reaches the audited admin update path as canonical text.
- Existing tests still cover rep denial and admin/director allow paths.

### Subagent review trace

Required review pass completed by subagent `019e6ab8-d975-7920-bc6d-fdc04ea1a818`:

- Tenant receipts: reviewer read the migration and worker, confirmed `(tenant_schema, audit_log_id)` is used for receipt schema, lookup, insert/upsert, and Resend idempotency, and found no remaining gap.
- Office link: reviewer read the worker builder, page, hook, and auth/tenant path, confirmed `officeId` is encoded in the email URL and turned into `x-office-id` for the first deal-detail fetch, and noted this uses per-request office context rather than a persisted active-office switch.
- Project-number validation: reviewer read the scripts and route validation, confirmed the API now rejects blank/oversized/lowercase-prefix/non-canonical values while keeping valid admin/director writes, and found no remaining gap.

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
- Codex fix round for PR #498:
  - `npm run build --workspace=shared`
  - `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/project-number-first-set-email.test.ts server/tests/modules/deals/patch-route.test.ts client/src/hooks/use-deals.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
  - `npm run typecheck --workspace=client`
  - `npm run typecheck --workspace=server`
  - `npm run typecheck --workspace=worker`
  - `npm run typecheck --workspace=shared`
  - `npm run build --workspace=shared`
  - `npm run build --workspace=server`
  - `npm run build --workspace=worker`
  - `npm run build --workspace=client`
- Codex re-review follow-up:
  - `npm run build --workspace=shared`
  - `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/project-number-first-set-email.test.ts server/tests/modules/deals/patch-route.test.ts client/src/hooks/use-deals.test.ts client/src/pages/deals/deal-detail-page.test.tsx --testTimeout=15000 --exclude '.worktrees/**'`
  - `npm run typecheck --workspace=server`
  - `npm run typecheck --workspace=client`
  - `npm run typecheck --workspace=shared`
  - `npm run build --workspace=shared`
  - `npm run build --workspace=server`
  - `npm run build --workspace=client`

CC tests cover:

- configured `PROJECT_NUMBER_EMAIL_CC` is passed as a visible `cc` option.
- unset production `PROJECT_NUMBER_EMAIL_CC` logs and sends to Christy without CC.
- the CC comes from the env var, with non-production default `adnaan.iqbal@gmail.com`.
- duplicate prevention remains one email send for the audit event, not one send per recipient.

Codex fix tests cover:

- two tenants with the same `audit_log_id` both send because receipts and idempotency keys include `tenant_schema`.
- migration no longer swallows trigger audit/job failures with `EXCEPTION WHEN OTHERS`.
- reps cannot set or clear `projectNumber` through the standard deal API.
- admins/directors can still mutate `projectNumber` through the standard deal API.
- project-number email links include `officeId`.
- `useDealDetail` turns `officeId` into the existing `x-office-id` request header.

Requested broad test sweep:

- `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`
- Current result: `48` failed files, `327` failed tests, `251` uncaught errors. The failures are still dominated by the known sandbox `listen EPERM` auth/supertest failure plus existing stale UI expectations. This is below the previously accepted triage baseline of `54` failed files / `342` failed tests, so the broad-suite failure count did not grow from the prior known rot profile.

## Deployment Note

The worker must deploy with the new `project_number_first_set_email` handler before or alongside the migration trigger. If an older worker polls the new job type before the handler exists, the existing queue logic can mark unknown job types dead.
