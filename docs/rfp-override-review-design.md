# RFP override review (second-look gate)

## Problem

After an RFP is declined in the first go/no-go round, the two designated leadership reviewers (Takashi + Adam
Shaw) should get final say: review the declined RFP on a dedicated page and either **approve the override**
(rescue it) or **re-confirm the denial**. This builds on the existing decline pipeline:

`SyncHub → POST /api/internal/rfp-declined → rfp_approval_status='declined' → trigger 0148 → worker emails
the requesting rep + RFP_REJECTION_EMAIL_RECIPIENTS (Takashi + Adam)`.

## What "approved" means (the key decision)

Normal approval is **not** an in-CRM button — it happens when SyncHub posts `bid-board-created` with a Procore
project id, which links Procore **and** advances the deal to Estimating. The CRM cannot mint Procore ids, so
the override **re-submits the RFP to SyncHub** for a fresh approval cycle rather than faking an approval. The
rescue then flows through the *real* pipeline: SyncHub re-evaluates → a `bid-board-created` callback links
Procore and advances to Estimating exactly as a first-round approval would.

## Behaviour

- **Approve override** (`POST /api/deals/:id/rfp-override/approve`): resets the deal's RFP fields to
  `pending_outbox` (new request event id; declined-cycle + prior override markers cleared; the requesting rep
  is preserved so a re-decline still notifies them) and enqueues an `rfp_request_delivery` job via the same
  `insertOpportunityRfpRequestJob` the initial trigger uses. Changing `declined → pending_outbox` does **not**
  fire the decline-email trigger (it only fires on `→ declined`).
- **Re-confirm denial** (`POST /api/deals/:id/rfp-override/reconfirm-decline`): leaves
  `rfp_approval_status='declined'` untouched and stamps `rfp_override_reviewed_at/by`,
  `rfp_override_decision='denial_reconfirmed'`, `rfp_override_note` so the decline is not perpetually
  re-flagged.
- Both are **idempotent**: the guarded `UPDATE ... WHERE rfp_approval_status='declined' AND
  rfp_override_reviewed_at IS NULL` matches 0 rows on a second attempt / already-approved / already-reviewed
  deal → `409 RFP_OVERRIDE_NOT_ACTIONABLE`, no downstream side-effect.

## State model (migration 0151)

Adds `rfp_override_reviewed_at`, `rfp_override_reviewed_by`, `rfp_override_decision`, `rfp_override_note` to
`deals`. No new `rfp_approval_status` value is introduced (a re-confirmed denial stays `declined`), so no
existing consumer of `'declined'` (the decline trigger, reporting) needs to change.

## Authorization (exactly Takashi + Adam)

Access is **not** role-based. The page and all three endpoints are gated by `requireRfpReviewer`, an email
allowlist sourced from the **same** `RFP_REJECTION_EMAIL_RECIPIENTS` env var that defines the decline-email
leadership recipients — one config, so the reviewer set and the notified set can never drift. A regular
admin/director who is not on the list gets `403`. The parser lives in
`@trock-crm/shared/lib/rfpReviewerEmails` and is consumed by both the worker (recipients) and the server
(gate). `isRfpReviewer` is surfaced on `/auth/me` so the frontend can gate the page; the server endpoints are
the hard boundary.

## Email

The existing RFP-decline email gains a primary **"Review & Decide"** button →
`https://trockcrm.com/rfp-review/{dealId}?officeId={officeId}` (the `officeId` carries the deal's tenant so a
cross-office reviewer doesn't 404 — the same #611 rationale as the existing deal link, which is kept as a
secondary link).

## Surfaces

- Backend: `server/src/modules/deals/rfp-override-service.ts` (new) + 3 thin routes on the authed `/deals`
  router; `requireRfpReviewer` in `middleware/rbac.ts`; `isRfpReviewer` on `/auth/me`.
- Frontend: `client/src/pages/rfp-review/rfp-review-page.tsx` + `client/src/hooks/use-rfp-review.ts`, route
  `/rfp-review/:dealId`.
- Shared: migration `0151`, the `deals` Drizzle columns, the reviewer-email parser.
- Worker: the decline-email review link.

## Tests

- `rfp-override.runtime.test.ts` (PGlite, CI lane): proves approve/re-submit and re-confirm never fire the
  decline-email trigger, the guard blocks a second review, and a genuine re-open → re-decline still emails.
- Service / route / middleware / shared-helper / email unit tests cover the idempotent branching, the `403`
  gate, the graceful `409`, and the email link.
