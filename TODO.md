# Follow-ups

Items flagged but not addressed in their originating commit. Pick one when scope and risk allow.

## Lead service

- **v1-client posting `source` alone gets silently dropped under v2.** `server/src/modules/leads/service.ts` — line ~1224, `else if (!v2Enabled && input.source !== undefined)`. Symptom mirrors the qualificationPayload bug (Commit 1) but lower stakes — only triggers if a stale browser bundle posts `source` instead of `sourceCategory`/`sourceDetail`. Fix path: either accept `source` as a legacy alias and route it through `resolveLeadSourceForWrite`, or have the API reject the legacy field with a clear error so old bundles fail loud instead of silent. Surfaced during 2026-04-27 CRM fixes batch.
- **Thread questionnaire node displayLabel through stage-gate field labels.** `server/src/modules/leads/stage-gate.ts` — `questionnaireFieldLabel()` currently does mechanical underscore-to-titlecase conversion for `question.<key>` rows in the advance-stage modal checklist. Won't match user-facing question text from the questionnaire authoring UI. Fix path: pass node `label` through from `evaluateLeadQuestionGate` (or look up by key in stage-gate when rendering) so UI shows the real display label. Surfaced during 2026-04-27 CRM fixes batch.

## Tests

- **Align test fixtures with prod stage slugs.** `server/tests/modules/leads/service.test.ts` around line 299 uses bare `sales_validation` slug instead of `sales_validation_stage`. V2 gate likely never fires in those fixtures. Not a regression — pre-dates this batch — but worth aligning test fixtures with prod slugs for accurate coverage. Surfaced during 2026-04-27 CRM fixes batch slug verification.

## Validation

- **Server-side rejection of non-ISO timeline_status on lead PATCH.** Currently normalization is client-only by design (avoids silent rewrite of existing legacy rows). But any non-form write path — API direct, scripts, future mobile, integrations, Bid Board writeback (Commit 9 of 2026-04-27 batch) — bypasses validation. Fix: add server-side reject (NOT rewrite) on PATCH when `qualificationPayload.timeline_status` is non-blank and not YYYY-MM-DD. Returns 422 with clear field error. Existing legacy rows continue to read fine. Surfaced during 2026-04-27 CRM fixes batch.

## Bid Board funnel (Commit 9 reminder)

- **SyncHub activity-push endpoint must NOT touch qualificationPayload or other lead fields directly.** Write to the `activities` table only. If SyncHub ever needs to update lead fields, that's a separate endpoint going through the same validation as the form. Flag locked in 2026-04-27 batch — verify Commit 9 implementation respects this before merging.

## Deals service

- **Wrap setDealContractSignedDate writes in db.transaction().** `server/src/modules/deals/service.ts` — SELECT → UPDATE → audit_log INSERT currently relies on the route's commitTransaction boundary. With Commit 6 adding a 4th write (commission INSERT) to this flow, partial failures become expensive (a deal could be marked contract-signed without a corresponding commission row, or vice versa). Move the entire flow inside an explicit `db.transaction()` so the four writes commit or roll back together. Surfaced during 2026-04-27 CRM fixes batch Commit 5 review.

## Production cutover checklist

- **Rotate Postgres password before T Rock production cutover.** Credential `syTYKTHBn...` has been printed to stdout multiple times during the 2026-04-27 CRM fixes batch (shell history, Railway variable reads, conversation logs). Rotation is a dashboard-only action: Postgres service → Variables tab → regenerate `POSTGRES_PASSWORD`. Verify all dependent services reference `DATABASE_URL` via `${{Postgres.DATABASE_URL}}` reference variables (not static copies) before rotating, or they will lose DB access. Re-run `grep -rn "syTYKTHBn" .` after rotation to confirm cleanup.

## Commissions table FK delete policy

- **0062 deal_signed_commissions: review FK delete behavior at production cutover (audit/legal).** Probe of applied schema (2026-04-27): `deal_id → tenant.deals(id)` is **ON DELETE CASCADE** (a hard-deleted deal wipes its booked-commission audit row — likely undesired for audit/legal); `rep_user_id → public.users(id)` and `created_by → public.users(id)` are **NO ACTION** (deleting a user with commissions will be blocked, which preserves history but breaks any user-cleanup flow). Decide at cutover: does deal hard-delete need RESTRICT or SET NULL on the commission row? Does rep_user_id need SET NULL to allow user soft-delete + rename-to-tombstone? Surfaced during 2026-04-27 CRM fixes batch Commit 6 / migration 0062 apply.

## Verification email flow

- **Race condition on multi-lead-per-company verification email.** `server/src/modules/leads/service.ts` ~line 1023-1067. If two createLead calls race against the same brand-new company, both can read `companyVerificationStatus=null` and both send emails before either commits. Human-paced lead creation won't hit this; future API/batch imports might. Fix: advisory lock on companyId around the verification-email block, or move the email-send into a post-commit hook. Surfaced during 2026-04-27 CRM fixes batch Commit 4.
- **Rejected companies cannot trigger fresh verification flow.** Once `companyVerificationStatus='rejected'`, the `alreadyRequested` guard in createLead skips the verification email forever for new leads against that company. May or may not be intentional — confirm with Takashi during workflow review. If intentional: document. If not: add an admin "reset verification" action to clear the rejected state. Surfaced during 2026-04-27 CRM fixes batch Commit 4.
- **Tokenized magic links for company verification email CTAs.** Currently the Approve/Reject buttons in the verification email point at frontend URLs that prompt session login + confirm before POST. Out-of-app one-click approval (without login) requires a token store, expiry policy, single-use enforcement. Bigger workstream — defer until requested. Surfaced during 2026-04-27 CRM fixes batch Commit 4.
