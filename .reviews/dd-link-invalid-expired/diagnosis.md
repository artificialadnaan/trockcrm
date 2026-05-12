# DD Email Link Invalid/Expired Diagnosis

Date: 2026-05-12
Branch: `fix/dd-link-invalid-expired`
Base choice: `fix/test-suite-triage-and-dd-smoke` local head `af450f3f`, because `origin/fix/test-suite-triage-and-dd-smoke` was absent after fetch and `gh pr list --search "test-suite-triage"` did not return that branch. The local checkout contained the in-flight DD smoke commit, so this branch was based on that commit to avoid forking `server/src/modules/leads/due-diligence-service.ts`.

## Surface Area

- Email construction: `server/src/modules/leads/due-diligence-service.ts`
  - `buildLeadDueDiligenceEmail()` builds the review link from `API_BASE_URL ?? FRONTEND_URL ?? http://localhost:3001`.
  - Current link shape is `/api/public/lead-due-diligence?token=<64-hex-token>`.
- Public route: `server/src/modules/leads/public-due-diligence-routes.ts`
  - `GET /api/public/lead-due-diligence?token=...` renders the public decision HTML.
  - `POST /api/public/lead-due-diligence/decide` records approval/rejection.
- Token persistence: `shared/src/schema/tenant/lead-due-diligence-approvals.ts`
  - Raw 64-hex token stored in tenant `lead_due_diligence_approvals.approval_token`.
  - No `expires_at`, `used_at`, or `revoked_at` columns exist. The public message says "invalid or expired", but the current model only supports invalid format, not found, missing linked lead summary, or non-pending/already-decided.
- Validator: `findApprovalByToken()` scans tenant schemas with `office_%`, then `renderDueDiligenceDecisionPage()` loads the lead summary from the matched tenant schema.
- `/p/:token` is not DD. It is the public photo viewer SPA route in `client/src/App.tsx`.

## Production Reproduction Evidence

Preflight:

- `env -u RAILWAY_API_TOKEN railway whoami`: authenticated as `adnaan.iqbal@gmail.com`.
- Railway context from this worktree: project `T Rock CRM`, environment `production`, service `Frontend`.
- Health checks:
  - `https://api-production-ad218.up.railway.app/api/health`: HTTP 200.
  - `https://trockcrm.com/api/health`: HTTP 200.

Retained smoke run:

- Command used Railway API/Postgres env, `SMOKE_EMAIL_OVERRIDE_CONFIRMED=1`, and `--retain`.
- Created a retained smoke lead in `office_dallas`.
- Created a retained smoke DD approval.
- `email_sent_at`: `2026-05-12T17:33:18.114Z`.
- `email_message_id`: captured in local terminal output, redacted from committed docs.
- Persisted token: redacted from committed docs.

Direct link checks before cleanup:

- `GET https://api-production-ad218.up.railway.app/api/public/lead-due-diligence?token=<redacted-token>`: HTTP 200, rendered the DD decision page.
- `GET https://trockcrm.com/api/public/lead-due-diligence?token=<redacted-token>`: HTTP 200, rendered the DD decision page.
- `GET https://trockcrm.com/p/<redacted-token>`: served the frontend SPA/photo-viewer route, not DD.

Existing pending rows:

- After the retained smoke link was opened and approved, a production query across tenant DD approval tables found no pending approvals with `email_sent_at IS NOT NULL AND decided_at IS NULL`.
- Historical unsent rows from the earlier report were already approved and had `email_sent_at = NULL`; they do not need resend.

## Root Cause

The production DD token path is valid for a retained/persistent approval row. The immediately-invalid link evidence is consistent with the in-flight smoke harness, not the core DD approval service:

- `scripts/smoke-dd-email-flow.ts` sends a real DD email, then deletes the smoke lead and its `lead_due_diligence_approvals` row by default unless `--retain` is passed.
- The pre-merge smoke record shows `retained: false` and `deletedLeadCount: 1`.
- If a human opens that email after the script cleanup, the public route correctly cannot find the token and renders the generic invalid/expired page.

This explains a freshly sent email becoming invalid immediately without a TTL issue: the row was deleted by smoke cleanup, not expired by application logic.

## Fix Direction

The app should still be hardened because go-live observability is weak:

- Add path-style DD links (`/api/public/lead-due-diligence/:token`) while keeping the existing query-token route backward compatible.
- Log specific server-side validation failure reasons: invalid format, not found, missing lead summary, and already-used POST attempts. Keep the public HTML generic.
- Add regression coverage proving the email link token is accepted by the public validator route.
- Update the smoke harness so a "run" validates the persisted link before cleanup. Cleanup should happen after validation, not before a human can ever know whether the link works.

The current schema does not support true `expired`, `revoked`, or `invalid_signature` states: DD approvals store a raw random token and have no `expires_at`, `revoked_at`, or signature/JWT fields. Those labels are therefore not distinguishable without a future schema/signing change.

## Assumptions

- The reported screenshot came from an email generated by the production smoke path or another test path that cleaned up the approval row. I could not inspect the recipient's exact email body because the production Resend API key is send-only.
- Since the current schema has no expiration/revocation columns, "expired" remains only generic user-facing copy until a future schema change adds explicit expiration semantics.
