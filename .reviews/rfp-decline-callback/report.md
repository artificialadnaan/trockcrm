# RFP Decline Callback Build Report

## Grounding Findings

Existing approval callback: `/api/internal/bid-board-created` is defined in `server/src/modules/internal-rfp/routes.ts` and mounted from `server/src/app.ts` under `/api/internal`. It uses `express.raw`, verifies `x-rfp-request-signature` with HMAC-SHA256 over the raw JSON body using `SYNCHUB_SHARED_SECRET`, scans active `office_%` tenant schemas to find `sourceDealId`, validates `rfpApprovalRequestId` against the deal, then transactionally links Bid Board fields and sets `rfp_approval_status = 'approved'`. It logs activity via `logActivityWithPgClient` and can move the deal to `estimating` or `service_estimating` with stage history.

Current deal RFP fields in `shared/src/schema/tenant/deals.ts`: `rfp_approval_requested_at`, `rfp_approval_request_event_id`, `rfp_approval_requested_by`, `rfp_approval_request_id`, `rfp_approval_token`, `rfp_approval_status`, `rfp_conflict_reason`, `rfp_conflict_with`, and `rfp_last_attempt_error`.

Observed status values: `pending_outbox` from trigger/retry enqueue, `pending` from worker delivery success, `conflict` and `send_failed` from worker outcomes, and `approved` from the approval callback. Client types already included `declined`; this PR adds CRM persistence and callback handling for that state.

## Endpoint And Auth

Added `POST /api/internal/rfp-declined` in `server/src/modules/internal-rfp/routes.ts`. It uses the same raw-body HMAC verification as `/api/internal/bid-board-created`: `x-rfp-request-signature`, `SYNCHUB_SHARED_SECRET`, SHA-256, and timing-safe comparison.

Payload accepted: `sourceDealId`, `rfpApprovalRequestId`, optional `denialReason` or `reason`, and optional `declinedAt`. Invalid JSON, non-object JSON, malformed UUIDs, unknown deals, stale callbacks, and invalid states return typed JSON responses instead of falling into 500s.

## Declined State

Added tenant deal columns:

- `rfp_declined_reason text`
- `rfp_declined_at timestamptz`

Schema updates are in `shared/src/schema/tenant/deals.ts`, with migration `migrations/0137_rfp_decline_callback.sql` for all tenant schemas.

The declined mutation is handled by `server/src/modules/deals/rfp-decline-service.ts`, so the route does not inline the deal row write. The service sets `rfp_approval_status = 'declined'`, stores the reason and timestamp, writes `deal_history`, and records an audit activity entry. The route mirrors approval-callback tenant resolution and transaction handling.

The client deal type now includes `rfpDeclinedReason` and `rfpDeclinedAt`, and the existing RFP status block displays them for declined deals.

## Idempotency

Duplicate callbacks for an already declined deal with the same `rfpApprovalRequestId` return success with `idempotent: true`. Stale callbacks with a different request id return success with `reason: stale_callback_ignored` and do not mutate the deal. A same-request race where another callback already applied the decline is re-read after the zero-row update and also returns idempotent success.

Invalid-state examples such as no request id or no pending RFP return `409` with `rfp_decline_invalid_state`.

## Tests

Passed:

- `npm run build --workspace=shared`
- `npm run typecheck`
- `TMPDIR=/private/tmp npx vitest run server/tests/modules/internal-rfp/rfp-declined.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
- `TMPDIR=/private/tmp npx vitest run server/tests/modules/internal-rfp/ --testTimeout=15000 --exclude '.worktrees/**'` with localhost binding allowed: 28 passed

Required full-suite command run on the final diff:

`TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`

Result: failed with existing unrelated failures. Final summary: 51 failed files, 476 passed files, 331 failed tests, 3691 passed tests, 4022 total tests, and 251 errors.

Pre-existing/unrelated failure buckets observed include sandbox `listen EPERM` and null-port Supertest failures, known `deal-list-page.test.tsx`, `detail-page-shell.test.tsx`, deal detail visual KPI assertions, lead form tests, lead service mock shape failures, email route access expectations, property/sales-review related tests, and other broad-suite failures outside this RFP decline callback change.

## Review Rounds

Round 1, Mendel: found malformed `sourceDealId` could become a Postgres UUID error and already-declined stale request ids were misclassified as duplicates. Fixes applied: UUID validation, typed invalid payload response, stale-vs-duplicate handling, and regression tests.

Round 2, Cicero: found concurrent duplicate callbacks could return 409 if both read pending and one lost the conditional update. Fix applied: zero-row updates now re-read the deal and return idempotent success when it is already declined for the same request id, with a regression test.

Round 3, Pasteur: found signed JSON `null` parsed successfully and could throw before typed validation. Fix applied: non-object payload guard with a regression test.

## PR #490 Follow-Up Fixes

Addressed Codex review findings on commit `3094f600`:

- Added a `Buffer.isBuffer(req.body)` guard on `POST /api/internal/rfp-declined` before HMAC verification. Non-raw bodies now return typed `422 invalid_payload` instead of reaching `crypto.createHmac().update()`.
- Tightened `rfpApprovalRequestId` validation to require a finite integer. Non-finite and fractional numeric ids now return typed `422 invalid_payload` instead of being acknowledged as stale callbacks.
- Replaced string coercion for decline reasons with trim-first string validation. Blank `denialReason` now falls back to `reason`, while non-string `denialReason` and non-string fallback `reason` values are rejected as `invalid_payload`.

Additional tests were added in `server/tests/modules/internal-rfp/rfp-declined.test.ts` for non-Buffer bodies, non-finite and non-integer request ids, blank denial reason fallback, non-string denial reason rejection, and non-string fallback reason rejection.

Follow-up review round, Godel: found no route behavior issues and flagged one test gap for non-string fallback `reason`. Fix applied with an explicit regression test.

Follow-up verification:

- `TMPDIR=/private/tmp npx vitest run server/tests/modules/internal-rfp/rfp-declined.test.ts --testTimeout=15000 --exclude '.worktrees/**'`: passed, 16 tests.
- `TMPDIR=/private/tmp npx vitest run server/tests/modules/internal-rfp/ --testTimeout=15000 --exclude '.worktrees/**'` outside sandbox for Supertest listener binding: passed, 34 tests.
- Required full-suite command outside sandbox: failed with existing unrelated failures. Final summary: 23 failed files, 504 passed files, 84 failed tests, 3944 passed tests. Observed buckets remained outside the RFP decline fix, including `detail-page-shell.test.tsx`, `kanban-deal-card.test.tsx`, `deal-list-page.test.tsx`, deal detail KPI visual assertions, lead form/service mock failures, property consistency tests, report-builder SQL quoting expectations, and sales-review service expectations.
