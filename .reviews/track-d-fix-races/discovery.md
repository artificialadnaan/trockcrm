# Track D Fix-Forward Discovery: Trigger RFP Races and UX

Date: 2026-05-10
Branch: `fix/trigger-rfp-races-and-ux`
Base: `d186213` (`main`, includes Track D PR #211)

## Current Trigger Path

`POST /api/deals/:id/trigger-rfp` lives in `server/src/modules/deals/routes.ts`.

Current sequence:

1. `getDealById(req.tenantDb, id, role, userId)` loads a role-filtered snapshot.
2. Route checks assigned rep/admin authorization.
3. Route loads stage slug via `loadDealStageSlug`.
4. Route checks canonical Opportunity stage.
5. Route checks Bid Board ownership using the snapshot plus inferred ownership.
6. Route checks `rfpApprovalRequestedAt` and `rfpApprovalStatus`.
7. Route evaluates scope readiness via `evaluateDealScopingReadiness`.
8. Route calls `enqueueOpportunityRfpIfNeeded`.
9. The helper inserts a `job_queue` row with `jobType = "rfp_request_delivery"`.
10. The route updates the deal with `rfpApprovalRequestedAt`, `rfpApprovalRequestEventId`, `rfpApprovalRequestedBy`, and `rfpApprovalStatus = "pending_outbox"`.
11. The route inserts a `domain_event` job for `deal.opportunity.entered`.
12. The route commits the request transaction and emits the local event.

The request middleware starts a tenant transaction before route handlers and commits only when `req.commitTransaction()` is called. The problem is not missing transaction plumbing; it is that the eligibility read and side-effect writes are not protected by an atomic guard. The RFP job insert currently happens before the deal is marked triggered, so two concurrent requests can both insert delivery jobs.

## Enqueue Helper

`enqueueOpportunityRfpIfNeeded` in `server/src/modules/deals/rfp-enqueue.ts`:

- Checks `isOpportunityRfpEventEnabled()`.
- Returns `already_requested` if the input snapshot has `rfpApprovalRequestedAt`.
- Generates a UUID event id.
- Builds deal updates for `rfpApprovalRequestedAt`, `rfpApprovalRequestEventId`, `rfpApprovalRequestedBy`, `rfpApprovalStatus`.
- Loads payload metadata through the same `tenantDb`.
- Inserts one `job_queue` row for `rfp_request_delivery`.
- Returns the generated deal updates for the caller to apply.

It does not open its own connection and can run in the existing transaction. It needs a reserved-job insertion path because the atomic fix will update the deal before inserting the job; the current helper would then treat that reserved deal as already requested.

## Scope Readiness

`GET /api/deals/:id/scoping-intake/readiness` returns:

```json
{
  "readiness": {
    "status": "draft" | "ready" | "activated",
    "errors": {
      "sections": {},
      "attachments": {}
    },
    "completionState": {},
    "requiredSections": [],
    "requiredAttachmentKeys": [],
    "attachmentRequirements": []
  }
}
```

The frontend button only needs `status`: `ready` or `activated` enables the button; `draft` disables it.

## Existing UI Path

`client/src/pages/deals/deal-detail-page.tsx` computes `showTriggerRfpButton` from:

- current canonical stage is `opportunity`
- user is admin or assigned rep
- deal is not Bid Board owned
- no `rfpApprovalStatus`
- no `rfpApprovalRequestedAt`

The readiness effect only depends on `deal.id` and `showTriggerRfpButton`, so scope saves inside `DealScopingWorkspace` do not trigger a fresh readiness fetch.

The click handler currently has one `try/catch` around both `POST /trigger-rfp` and `refetch()`, so a successful trigger followed by a refetch failure displays a trigger failure error.

## Feature Flag

`isOpportunityRfpEventEnabled()` is code/env based:

```ts
env.ENABLE_OPPORTUNITY_RFP_EVENT === "true"
```

There is no existing frontend feature endpoint. The localized approach is to add an `isRfpTriggerEnabled` boolean to the deal detail API response and hide the Trigger RFP button when false.

## Auth Error Ordering

`getDealById` throws a generic 403 for reps viewing deals assigned to others. Because the trigger route calls it before route-level trigger authorization, non-assigned reps can receive a generic 403 instead of `RFP_UNAUTHORIZED`. The fix should use a lightweight direct deal read inside the route and perform the trigger-specific authorization before any full detail/service helper can throw.

## Chosen Atomic Guard Pattern

Chosen: **B. Conditional UPDATE guard**.

Rationale:

- It directly protects the thing that makes a trigger eligible: the deal row's RFP status and ownership/stage fields.
- It avoids relying on a long-lived application-level snapshot.
- It ensures a losing concurrent request updates zero rows before any RFP job is inserted.
- It fits the current request transaction model: conditional deal update, RFP delivery job insert, and domain event insert all occur before `req.commitTransaction()`.

Implementation shape:

1. Check the feature flag before writes.
2. Directly load a minimal deal snapshot for 404 and trigger-specific authorization.
3. Evaluate stage, Bid Board ownership, already-triggered state, and scope readiness before writes for clear initial error messages.
4. Generate `eventId` and `requestedAt`.
5. Execute a conditional update returning the reserved row:

```sql
UPDATE deals
   SET rfp_approval_status = 'pending_outbox',
       rfp_approval_requested_at = now(),
       rfp_approval_request_event_id = $eventId,
       rfp_approval_requested_by = $userId
 WHERE id = $dealId
   AND stage_id = $opportunityStageId
   AND rfp_approval_status IS NULL
   AND rfp_approval_requested_at IS NULL
   AND is_bid_board_owned = false
   -- plus assigned_rep_id = $userId for reps only
 RETURNING *;
```

6. If zero rows return, re-read the row in the same transaction and return a structured 409:
   - `RFP_STAGE_MISMATCH`
   - `RFP_ALREADY_TRIGGERED`
   - `RFP_OWNERSHIP_CHANGED`
   - `RFP_ALREADY_HANDED_OFF`
7. Only after one row is returned, insert the `rfp_request_delivery` job using the same `tenantDb`.
8. Insert the domain event job, commit, and emit local event.

Admin path: perform authorization before the update and omit the `assigned_rep_id` predicate for admins.

## Readiness Refresh Strategy

Add `onReadinessChanged?: () => void` to `DealScopingWorkspace`.

Inside the workspace, compare readiness signatures after successful intake loads/saves/uploads. Fire the callback only after a successful save/link/upload changes readiness status/errors/completion shape. In the parent detail page, increment a refresh key and include it in the readiness effect dependencies.

## Refetch Error Strategy

Split trigger submission and refetch into two `try/catch` blocks:

- Trigger failure: set inline error, no success toast.
- Trigger success: show success toast.
- Refetch failure after success: show non-blocking info toast; do not set the trigger error.

## Tests To Update/Add

Server:

- Happy path still reserves the deal, inserts exactly one RFP delivery job, inserts a domain event, commits.
- Two simultaneous route calls against a stateful mock: one 200, one 409, exactly one RFP delivery job.
- Already triggered returns 409 on the losing/second path.
- Stage mismatch returns 409 when the conditional guard fails after stage movement.
- Bid Board owned returns 409 on guard failure.
- Unauthorized rep returns 403 `RFP_UNAUTHORIZED`.
- Feature flag disabled returns `RFP_EVENT_DISABLED` before writes.

Frontend:

- Button hidden when `isRfpTriggerEnabled` is false.
- Readiness refresh key updates button state after scoping workspace callback.
- Trigger success plus refetch failure shows success/info, not failure.
- Trigger failure shows error and no success toast.
