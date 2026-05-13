# Scope Read-Only After RFP Diagnosis

Generated: 2026-05-12

## Scope Surface

- Deal scope is rendered by `client/src/components/deals/deal-scoping-workspace.tsx`.
- Deal detail currently chooses between `DealScopingWorkspace` and `DealScopingReadOnlyPanel` in `client/src/pages/deals/deal-detail-page.tsx`.
- `DealScopingReadOnlyPanel` explains Bid Board ownership but does not render submitted scope values, so reps lose the reference view after handoff.
- Lead scope is a separate pre-conversion component: `client/src/components/leads/lead-scoping-workspace.tsx`. The post-RFP problem is on the converted deal scope surface.

## RFP / Handoff Signal

- The manual RFP trigger is `POST /api/deals/:id/trigger-rfp`.
- It sets `deals.rfpApprovalRequestedAt`, `deals.rfpApprovalRequestEventId`, `deals.rfpApprovalRequestedBy`, and `deals.rfpApprovalStatus = "pending_outbox"`.
- Bid Board / downstream ownership is also represented by `isBidBoardOwned`, `bidBoardStageSlug`, `bidBoardLinkedAt`, `bidBoardProjectNumber`, `readOnlySyncedAt`, and related mirror fields.
- The conservative lock signal is: once `rfpApprovalRequestedAt` or RFP status exists, scope stays locked even if stage later moves back. Downstream Bid Board/mirror ownership also locks it.

## Current Backend Behavior

- `GET /api/deals/:id/scoping-intake`, `PATCH /api/deals/:id/scoping-intake`, readiness evaluation, attachment linking, and activation all call `assertDealScopingEditable`.
- `assertDealScopingEditable` currently enforces Bid Board stage ownership. This is correct for writes but wrong for reads: it can block loading the exact scope users need to reference.
- There is no admin override for post-RFP scope edits, and no audit row specifically records an admin support edit to frozen scope.

## Root Cause

The same editability guard is used for read and write flows, while the frontend replaces the scope form with a generic Bid Board lock panel. That turns a required read-only business state into a hidden/unavailable reference state.

## Chosen Approach

- Add a first-class scope lock state derived from `rfpApprovalRequestedAt`, RFP status, Bid Board link/mirror fields, Bid Board ownership, or a stage past Opportunity.
- Let `GET /scoping-intake` and readiness evaluation load the scope snapshot even when locked.
- Make write paths reject locked scope with `403 "Scope is read-only after RFP submission"` unless the user is an admin and explicitly sends an override flag.
- Keep admin override explicit: the UI shows a `Force edit` action only to admins, asks for confirmation, sends `forceEditAfterRfp: true`, and the server audit-logs the override edit.
- Reuse `DealScopingWorkspace` in read-only mode instead of the generic lock panel, so all submitted values remain visible.

## Assumptions

- `rfpApprovalRequestedAt` is the canonical set-once RFP submission timestamp. `rfpApprovalStatus` is also treated as a lock because existing records may carry status without the timestamp.
- Admin support edits are allowed but must be intentional and auditable.
- Reps/directors should still see linked files and scope fields, but cannot upload/link/edit from the scope tab once locked.
