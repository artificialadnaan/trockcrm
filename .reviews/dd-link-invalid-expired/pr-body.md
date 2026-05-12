## Summary

Fixes the DD email "invalid or expired" blocker by hardening the public tokenized link path and the smoke harness:

- Builds new DD email links as `/api/public/lead-due-diligence/:token`.
- Keeps the previous `/api/public/lead-due-diligence?token=...` route compatible.
- Logs specific feasible server-side rejection reasons without logging raw tokens.
- Rejects reused public POST decisions generically and logs `already_used`.
- Updates `scripts/smoke-dd-email-flow.ts` to validate the public DD link before cleanup, using the actual Resend href when message readback is available.

## Base Branch Decision

Preflight requested:

- `git fetch origin`
- `git branch -r | grep test-suite-triage`
- `gh pr list --search "test-suite-triage"`

Result: no `origin/fix/test-suite-triage-and-dd-smoke` ref and no matching GitHub PR were available after fetch, but the main checkout was already on local `fix/test-suite-triage-and-dd-smoke` at `af450f3f`. I branched from that local commit to avoid forking the DD smoke work in `server/src/modules/leads/due-diligence-service.ts`.

## Diagnosis

See `.reviews/dd-link-invalid-expired/diagnosis.md`.

Key production evidence:

- Retained production smoke created a DD approval in `office_dallas`; production IDs and token are redacted from PR docs.
- The persisted token rendered the DD decision page on both:
  - `https://api-production-ad218.up.railway.app/api/public/lead-due-diligence?token=...`
  - `https://trockcrm.com/api/public/lead-due-diligence?token=...`
- `/p/:token` is the public photo viewer route, not DD.
- The prior smoke script deleted the smoke lead and approval row by default after email send. A human opening that email after cleanup would hit the generic invalid/expired page because the token row was gone.

## Stuck Approval / Resend Plan

Current production inspection after the retained smoke approval found no pending rows with `email_sent_at IS NOT NULL AND decided_at IS NULL`. Historical `email_sent_at IS NULL` rows were already approved, so there is no live stuck DD approval requiring resend at PR time.

If a stuck pending approval appears later, the safe recovery path is:

1. Query tenant `lead_due_diligence_approvals` for `status='pending' AND email_sent_at IS NOT NULL AND decided_at IS NULL`.
2. Validate each token via the public route.
3. For any broken token, regenerate and resend through a one-shot script or add an admin resend action. This PR does not add a permanent resend UI because no current pending stuck production approvals were found.

## Verification

Passed locally:

- `git diff --check`
- `npm run typecheck --workspace=server`
- `npx vitest run server/tests/modules/leads/due-diligence-service.test.ts server/tests/modules/leads/public-due-diligence-routes.test.ts`
- `npx vitest run server/tests/modules/leads/routes.test.ts -t "dispatches the DD email"`
- `npx vitest run server/tests/modules/leads/routes.test.ts -t "returns the structured blocked-move payload"`

Full server suite note:

- `npm run test --workspace=server` is currently blocked in this sandbox by unrelated Supertest listener failures: `listen EPERM: operation not permitted 0.0.0.0`, plus several existing 5s timeout flakes under full concurrency. Focused DD and adjacent route tests pass.

## Review

Three subagent review rounds completed.

- Round 1 found POST reuse, smoke href, and dispatch-test gaps. Fixed.
- Round 2 found short-reject reused-token ordering and Resend-readback fallback gaps. Fixed.
- Round 3 found no blocking or important bugs.
