# Track D Manual RFP Trigger Discovery

Date: 2026-05-10
Branch: feat/manual-rfp-trigger
Base: origin/main at b629551

## Preflight

- Worktree: `/Users/adnaaniqbal/projects/trockcrm-rfp-trigger`
- Branch: `feat/manual-rfp-trigger`
- Status before implementation: clean
- Latest main includes:
  - PR #204: `b3d4523 Merge pull request #204 from artificialadnaan/fix/lead-conversion-projecttype`
  - PR #205: `3cda068 Merge pull request #205 from artificialadnaan/fix/scope-tab-get-write-bug`

## RFP Enqueue Function

Function: `enqueueOpportunityRfpIfNeeded` in `server/src/modules/deals/rfp-enqueue.ts`.

Inputs:
- `tenantDb`
- full deal row
- `userId`
- `officeId`
- optional `transitioningFrom`
- `enteredAt`

Feature gate:
- `isOpportunityRfpEventEnabled()` in `server/src/config/feature-flags.ts`
- Controlled by `ENABLE_OPPORTUNITY_RFP_EVENT === "true"`
- If disabled, returns `{ enqueued: false, reason: "feature_disabled" }`

Idempotency:
- Checks `deal.rfpApprovalRequestedAt != null`
- If already requested, returns `{ enqueued: false, reason: "already_requested" }`
- Does not check `rfpApprovalStatus` directly; status is a UI/state signal, while requested timestamp is the lifetime idempotency guard.

Side effects inside the function:
- Creates a new event UUID.
- Builds deal update fields:
  - `rfpApprovalRequestedAt`
  - `rfpApprovalRequestEventId`
  - `rfpApprovalRequestedBy`
  - `rfpApprovalStatus = "pending_outbox"`
- Inserts a `job_queue` row:
  - `jobType = "rfp_request_delivery"`
  - payload from `buildRfpRequestDeliveryPayload`
  - source event id `crm:deal-stage:opportunity:<eventId>`
  - `status = "pending"`
  - `maxAttempts = 8`
- Returns the job id and deal update fields.

Important distinction:
- The function itself does not update the deal row and does not insert the `deal.opportunity.entered` domain event.
- `stage-change.ts` currently applies returned deal updates and separately inserts the `deal.opportunity.entered` domain event when enqueue succeeds.
- `conversion-service.ts` currently applies returned deal updates but does not insert the domain event.

## Current Callers

Search found only two production callers:

1. `server/src/modules/deals/stage-change.ts`
   - Imports `enqueueOpportunityRfpIfNeeded`.
   - Calls it when target stage slug is `opportunity` and current stage slug is not `opportunity`.
   - If enqueued, merges returned RFP fields into the deal stage update.
   - Later inserts a `deal.opportunity.entered` domain event job and local event.

2. `server/src/modules/leads/conversion-service.ts`
   - Imports `enqueueOpportunityRfpIfNeeded`.
   - Calls it after converted deal creation if resolved target deal stage slug is `opportunity`.
   - If enqueued, updates the deal with returned RFP fields.

No dormant manual trigger endpoint or frontend "Trigger RFP" button exists.

## Scope Readiness Endpoint

Route: `GET /api/deals/:id/scoping-intake/readiness` in `server/src/modules/deals/routes.ts`.

Implementation:
- Calls `evaluateDealScopingReadiness(req.tenantDb!, req.params.id)`.
- Returns `{ readiness }`.

Readiness shape from `client/src/hooks/use-deals.ts`:

```ts
interface DealScopingReadiness {
  status: "draft" | "ready" | "activated";
  errors: {
    sections: Record<string, string[]>;
    attachments: Record<string, string[]>;
  };
  completionState: Record<string, {
    isComplete: boolean;
    missingFields: string[];
    missingAttachments: string[];
  }>;
  requiredSections: string[];
  requiredAttachmentKeys: string[];
  attachmentRequirements: Array<{
    key: string;
    category: string;
    label: string;
    satisfied: boolean;
  }>;
}
```

Ready signal:
- Use `readiness.status !== "draft"` as the backend gate.
- `ready` and `activated` mean required scoping is satisfied.
- For the manual RFP button, `ready` is expected before handoff. `activated` should also be treated as satisfied if it appears.

Readiness side effect:
- `evaluateDealScopingReadiness` persists refreshed readiness when an intake row exists.
- This was already true for the GET endpoint after PR #205; the scope form itself now renders despite validator errors.

## Existing Deal Action Buttons

File: `client/src/pages/deals/deal-detail-page.tsx`.

Action surface:
- `actionsSlot` passed to `DetailPageShell`.
- Existing buttons:
  - native `Link` styled with `buttonVariants` for Edit.
  - native `a` styled with `buttonVariants` for Procore.
  - `Move Stage` dropdown for forward and director/admin backward stage changes.
  - `Reopen Deal` dropdown for director/admin terminal-stage reopening.
  - `TaskCreateDialog`.
  - `More` dropdown for edit/delete.

Stage gates:
- Current canonical stage is computed as `canonicalCurrentStageSlug`.
- Opportunity stage is already computed as `isOpportunityStage`.
- Bid Board ownership is computed as `isBidBoardOwned`.
- Existing stage movement uses `handleStageChange`, `StageChangeDialog`, and `refetch`.

## Existing RFP Status UI

Component: `RfpApprovalStatusBlock` in `client/src/pages/deals/deal-detail-page.tsx`.

The block is hidden when `deal.rfpApprovalStatus` is null.

Known frontend states:
- `pending_outbox`: RFP being sent to approvers.
- `pending`: RFP under review.
- `approved`: RFP approved.
- `declined`: RFP declined.
- `conflict`: RFP request conflict.
- `cancelled_source_ineligible`: RFP cancelled due to eligibility failure.
- `send_failed`: RFP delivery failed; exposes retry button.

Button visibility decision:
- Manual trigger should show only when status is null and no request timestamp has been set.
- If any RFP status exists, hide the button.
- Because idempotency is timestamp-based, the backend should also reject when `rfpApprovalRequestedAt` is non-null even if status is null.

## Authorization Pattern

Existing deal route access uses `getDealById(req.tenantDb!, id, role, userId)`.

Behavior from `server/src/modules/deals/service.ts`:
- Returns 404/null when the deal does not exist.
- Throws 403 for reps trying to view another rep's deal.
- Admin/director can load any deal by this helper.

Manual trigger endpoint should use this helper first, then enforce the narrower product rule:
- rep can trigger own deal.
- admin can trigger any deal.
- director is not specified for this manual trigger; safest implementation is admin plus owning rep only.

## RFP State Visibility Rules

From discovered statuses and user requirement:
- Visible and potentially enabled: Opportunity stage, not Bid Board owned, `rfpApprovalStatus == null`, and `rfpApprovalRequestedAt == null`.
- Disabled: same as above but readiness status is `draft` or readiness cannot be loaded.
- Hidden:
  - not Opportunity
  - already triggered/in flight/approved/declined/conflict/send failed/cancelled
  - Bid Board owned or downstream

## Implementation Notes

- Hard-remove the two automatic enqueue calls.
- Preserve `enqueueOpportunityRfpIfNeeded` for manual use.
- Manual endpoint should return clear machine-readable error codes:
  - `RFP_WRONG_STAGE`
  - `RFP_SCOPE_INCOMPLETE`
  - `RFP_ALREADY_TRIGGERED`
  - `RFP_UNAUTHORIZED`
- The endpoint can use `readiness.status === "draft"` as the failure condition and include readiness errors in the response.
- The frontend should call the readiness endpoint only when the loaded deal is an untriggered Opportunity-stage CRM-owned deal.
