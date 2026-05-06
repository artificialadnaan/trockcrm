# CRM RFP Integration Design

This document covers Phase 5 Stop 5A for wiring T Rock CRM to SyncHub's normalized RFP approval endpoint. It is design only; implementation is gated until Stop 5B.

## 1. Stage-Transition Hook Discovery

The stage transition entry point is `server/src/modules/deals/stage-change.ts`.

Existing signatures:

```ts
// server/src/modules/deals/stage-change.ts:86
export interface StageChangeInput {
  dealId: string;
  targetStageId: string;
  userId: string;
  userRole: UserRole;
  officeId?: string;
  overrideReason?: string;
  lostReasonId?: string;
  lostNotes?: string;
  lostCompetitor?: string;
}

// server/src/modules/deals/stage-change.ts:98
export interface StageChangeResult {
  deal: typeof deals.$inferSelect;
  stageHistory: typeof dealStageHistory.$inferSelect | null;
  eventsEmitted: string[];
  _eventsToEmit: Array<{ name: string; payload: any }>;
}

// server/src/modules/deals/stage-change.ts:130
export async function changeDealStage(
  tenantDb: TenantDb,
  input: StageChangeInput
): Promise<StageChangeResult>
```

The HTTP route calling it is `server/src/modules/deals/routes.ts:611`:

```ts
// server/src/modules/deals/routes.ts:611
router.post("/:id/stage", async (req, res, next) => {
  // ...
  const result = await changeDealStage(req.tenantDb!, {
    dealId: req.params.id,
    targetStageId,
    userId: req.user!.id,
    userRole: req.user!.role,
    officeId: req.user!.activeOfficeId ?? req.user!.officeId,
    overrideReason,
    lostReasonId,
    lostNotes,
    lostCompetitor,
  });
  // ...
  await req.commitTransaction!();
  emitLocalDealEvents((result as any)._eventsToEmit ?? [], {
    officeId: req.user!.activeOfficeId ?? req.user!.officeId,
    userId: req.user!.id,
  });
});
```

Opportunity detection already exists inside the transaction:

```ts
// server/src/modules/deals/stage-change.ts:261
const shouldEmitOpportunityEntered =
  isOpportunityRfpEventEnabled() &&
  targetStage.slug === "opportunity" &&
  currentStage.slug !== "opportunity" &&
  currentDeal[0].rfpApprovalRequestedAt == null;
const opportunityEventId = shouldEmitOpportunityEntered ? randomUUID() : null;

if (shouldEmitOpportunityEntered) {
  dealUpdates.rfpApprovalRequestedAt = dealUpdates.stageEnteredAt;
  dealUpdates.rfpApprovalRequestEventId = opportunityEventId;
  dealUpdates.rfpApprovalRequestedBy = userId;
}
```

The durable async event is inserted later in the same function:

```ts
// server/src/modules/deals/stage-change.ts:413
if (shouldEmitOpportunityEntered && opportunityEventId) {
  const opportunityPayload = {
    eventName: DOMAIN_EVENTS.DEAL_OPPORTUNITY_ENTERED,
    eventId: opportunityEventId,
    idempotencyKey: `deal:${dealId}:rfp_approval:lifetime`,
    dealId,
    dealNumber: updatedDeal.dealNumber,
    dealName: updatedDeal.name,
    officeId: officeId ?? null,
    workflowRoute: updatedDeal.workflowRoute,
    fromStageId: currentStage.id,
    toStageId: targetStage.id,
    toStageSlug: "opportunity",
    enteredAt: dealUpdates.stageEnteredAt,
    requestedBy: userId,
    source: "crm_stage_change",
  } satisfies DealOpportunityEnteredEventPayload;
  // ...
  await tenantDb.insert(jobQueue).values({
    jobType: "domain_event",
    payload: opportunityPayload,
    officeId: officeId ?? null,
    status: "pending",
  });
}
```

Synchronous work today:

- `changeDealStage()` locks the deal row with `FOR UPDATE` (`server/src/modules/deals/stage-change.ts:136`).
- It validates the stage gate, enforces Bid Board read-only boundaries, updates the deal, inserts stage history, inserts `job_queue` rows, and returns `_eventsToEmit`.
- The route commits the transaction before local event emission (`server/src/modules/deals/routes.ts:643`).

Asynchronous work today:

- Durable jobs are inserted into `public.job_queue` in the same transaction (`server/src/modules/deals/stage-change.ts:381`).
- The worker polls `public.job_queue` every 2 seconds (`worker/src/index.ts:25` and `worker/src/index.ts:50`).
- `worker/src/queue.ts:22` uses `FOR UPDATE SKIP LOCKED` to avoid double processing.

Stop 5B plug-in point:

- Add the new `job_queue` insert for `job_type = "rfp_request_delivery"` inside the same `shouldEmitOpportunityEntered && opportunityEventId` branch.
- Set `rfpApprovalStatus = "pending_outbox"` in `dealUpdates` in the earlier `if (shouldEmitOpportunityEntered)` block, before `tenantDb.update(deals).set(dealUpdates)` runs at `server/src/modules/deals/stage-change.ts:338`.
- Build the normalized payload after `updatedDeal` is available, because the payload needs the committed stage timestamp and current deal values.
- Keep the existing `domain_event` job intact. The `rfp_request_delivery` job is an integration-delivery job, not a replacement for local domain events.

The exact Opportunity stage slug is `opportunity`; it is defined in `shared/src/types/enums.ts:4` and is already used by the stage transition hook.

## 2. Job Queue Integration

Reuse the existing public `job_queue` table instead of adding a new RFP-specific outbox table.

Job shape:

- Job type: `rfp_request_delivery`.
- `payload`: `{ dealId, syncHubUrl, body }`.
- `body`: the full normalized SyncHub request body accepted by `POST /api/rfp-requests`.
- `dealId`: CRM deal UUID used by the handler to update tenant deal state.
- `syncHubUrl`: normally `${SYNCHUB_BASE_URL}/api/rfp-requests`.
- `office_id`: active office id from the stage transition, so the worker can resolve the tenant schema.
- `max_attempts`: set to `8` on insert, overriding the queue default of `3`.

The existing worker backoff is `3^attempt` seconds. Setting `max_attempts = 8` gives a total wait of roughly 2.7 hours across retries: `3s`, `9s`, `27s`, `1.4m`, `4m`, `12m`, `36m`, `109m`. Add a code comment at the insert site explaining this is intentionally longer than the default queue retry window for SyncHub delivery.

Status mapping:

- Handler returns successfully: `job_queue` marks the row `completed`. The handler writes deal-side state before returning:
  - `rfpApprovalRequestId`
  - `rfpApprovalToken`
  - `rfpApprovalStatus = "pending"`
  - or conflict fields for `409`.
- Handler throws: `job_queue` marks the row `pending` with `run_after` backoff, or `dead` if `max_attempts` is reached.
- The generic worker does not know how to update deal records when a job becomes `dead`, so add a lightweight dead-row sweep.

Dead-row sweep:

- Runs every 60 seconds in `worker/src/index.ts`.
- Selects jobs where:
  - `status = 'dead'`
  - `job_type = 'rfp_request_delivery'`
  - `payload->>'dealHandled' IS NULL`
- Resolves the tenant schema from `office_id`.
- Updates the deal to:
  - `rfpApprovalStatus = "send_failed"`
  - `rfpLastAttemptError = job_queue.last_error`
- Updates the job payload with `dealHandled = true` so the same dead row is not handled twice.

## 3. Stage-Transition Hook Flow

When a deal moves into Opportunity and `isOpportunityRfpEventEnabled()` is true:

1. The existing stage transition validation runs unchanged.
2. Inside the same transaction, `dealUpdates` sets:
   - `rfpApprovalRequestedAt = stageEnteredAt`
   - `rfpApprovalRequestEventId = opportunityEventId`
   - `rfpApprovalRequestedBy = userId`
   - `rfpApprovalStatus = "pending_outbox"`
3. After the deal update returns `updatedDeal`, build the normalized SyncHub payload:

| SyncHub field | CRM source |
| --- | --- |
| `sourceSystem` | literal `"trock_crm"` |
| `sourceDealId` | `updatedDeal.id` |
| `sourceEventId` | `opportunityEventId` |
| `deal.name` | `updatedDeal.name` |
| `deal.projectNumber` | `updatedDeal.dealNumber`; this is the CRM project-number equivalent and is required by SyncHub idempotency |
| `deal.projectType` | `resolveProjectTypeCode({ projectType: updatedDeal.projectType, workflowRoute: updatedDeal.workflowRoute })` from `server/src/services/projectNumber.ts:47`; service route defaults to `"4"` and normal route defaults to `"9"` |
| `deal.amount` | first non-null numeric value from `awardedAmount`, `bidEstimate`, `ddEstimate`, `forecastRevenue` |
| `deal.estimator` | `updatedDeal.estimator` first, fallback `updatedDeal.bidBoardEstimator`, fallback assigned rep display name from users table, otherwise `null` |
| `deal.companyName` | joined `companies.name` from `updatedDeal.companyId`, fallback `contacts.companyName`, fallback `updatedDeal.bidBoardCustomerName` |
| `deal.contactName` | joined primary contact `firstName + " " + lastName`, fallback `updatedDeal.decisionMakerName` |
| `deal.clientEmail` | joined primary contact `email` |
| `deal.clientPhone` | joined primary contact `phone`, fallback `mobile` |
| `deal.address.street` | `updatedDeal.propertyAddress`, fallback joined `properties.address`, fallback `companies.address` |
| `deal.address.city` | `updatedDeal.propertyCity`, fallback joined `properties.city`, fallback `companies.city` |
| `deal.address.state` | `updatedDeal.propertyState`, fallback joined `properties.state`, fallback `companies.state` |
| `deal.address.zip` | `updatedDeal.propertyZip`, fallback joined `properties.zip`, fallback `companies.zip` |
| `deal.address.country` | `updatedDeal.propertyCountry` first, fallback literal `"US"` when any address field exists; otherwise `null` |
| `deal.description` | `updatedDeal.description` |
| `deal.dueDate` | `updatedDeal.bidDueDate` first; fallback joined source lead `bidDueDate` when `sourceLeadId` exists; fallback `updatedDeal.bidBoardDueDate`; convert date-only values to an ISO datetime |
| `deal.workflowRoute` | `updatedDeal.workflowRoute` |
| `attachments` | `[]` in Stop 5B unless an existing document attachment source is identified in implementation; document/photo upload sync remains editable but does not block RFP event delivery |

4. Insert one `job_queue` row:
   - `jobType = "rfp_request_delivery"`
   - `payload = { dealId: updatedDeal.id, syncHubUrl: ${SYNCHUB_BASE_URL}/api/rfp-requests, body: normalized payload }`
   - `officeId = officeId ?? null`
   - `status = "pending"`
   - `runAfter = now()`
   - `maxAttempts = 8`
5. Return stage transition success without waiting on SyncHub.

If the stage transition fails before commit, no delivery job is inserted and `rfpApprovalStatus` is not updated. This follows the route's existing transaction behavior.

## 4. Worker Flow

Add `handleRfpRequestDelivery(payload, officeId)` in `worker/src/jobs/rfp-request-delivery.ts` and register it as the `rfp_request_delivery` job handler.

Handler flow:

1. Resolve the tenant schema from `officeId` using the existing `resolveOfficeSchema` pattern.
2. Serialize `payload.body` to raw JSON bytes.
3. HMAC-sign those body bytes with `SYNCHUB_SHARED_SECRET`.
4. POST to `payload.syncHubUrl`.
5. Branch on response:
   - `201 Created`: update tenant deal with `rfpApprovalRequestId`, `rfpApprovalToken`, and `rfpApprovalStatus = "pending"`. Return successfully so `job_queue` marks the job `completed`.
   - `200 OK`: same as `201`; log that SyncHub treated the event as an idempotent replay. Return successfully.
   - `409 Conflict`: update tenant deal with `rfpApprovalStatus = "conflict"`, `rfpConflictReason = body.error`, and `rfpConflictWith = body.conflict`. Return successfully. This is a successful delivery because SyncHub processed the event and refused it intentionally; do not throw on `409`.
   - `401 Unauthorized`: throw with a clear message. The generic queue retries and eventually marks the job `dead`; terminal deal-side failure is handled by the dead-row sweep.
   - `422 Unprocessable`: throw with validation details. The generic queue retries and eventually marks the job `dead`.
   - `5xx`, network error, timeout: throw to trigger `job_queue` backoff retry.

The handler owns deal-side state for success paths (`201`, `200`, `409`). The dead-row sweep owns deal-side state for terminal failure paths after retry exhaustion (`401`, `422`, repeated `5xx`, network errors, timeout).

## 5. Deal Record Schema Additions

Add these columns to the tenant-scoped `deals` table in `shared/src/schema/tenant/deals.ts`, near the existing `rfpApprovalRequestedAt`, `rfpApprovalRequestEventId`, and `rfpApprovalRequestedBy` columns at `shared/src/schema/tenant/deals.ts:158`:

```ts
rfpApprovalRequestId: integer("rfp_approval_request_id"),
rfpApprovalToken: text("rfp_approval_token"),
rfpApprovalStatus: text("rfp_approval_status"),
rfpConflictReason: text("rfp_conflict_reason"),
rfpConflictWith: jsonb("rfp_conflict_with").$type<Record<string, unknown> | null>(),
rfpLastAttemptError: text("rfp_last_attempt_error"),
estimator: text("estimator"),
bidDueDate: timestamp("bid_due_date", { withTimezone: true }),
propertyCountry: text("property_country"),
```

Status values:

- `null`
- `pending_outbox`
- `pending`
- `approved`
- `declined`
- `conflict`
- `cancelled_source_ineligible`
- `send_failed`

These fields are CRM workflow state only. Bid Board ownership still uses the existing `isBidBoardOwned`, `procoreBidId`, `bidBoardStageSlug`, `bidBoardStatus`, and related mirror columns in `shared/src/schema/tenant/deals.ts:105`.

## 6. Inbound Endpoints

Mount both endpoints under `/api/internal` before global `express.json()` if a raw body is needed for HMAC verification. `server/src/app.ts:96` shows the existing pattern for raw-body HMAC routes by mounting Bid Board ingestion before JSON parsing.

### POST /api/internal/rfp-edits

Purpose: receive edited review-page fields from SyncHub for CRM-sourced requests. Phase 3 logs these edits in SyncHub; Phase 5 applies them here.

Auth:

- Header: `x-rfp-request-signature`.
- Secret: `SYNCHUB_SHARED_SECRET`.
- Verify HMAC SHA-256 against raw body bytes.
- Reject invalid signatures with `401`.

Body:

```ts
{
  rfpApprovalRequestId: number;
  sourceDealId: string;
  editedFields: Record<string, unknown>;
}
```

Behavior:

- Look up the deal by `sourceDealId`.
- Apply only whitelisted fields listed in Section 7.
- Reject unknown fields by omitting them from the update and listing them in `rejected`.
- Return `200` even when some fields are rejected; rejected fields are validation results, not transport failures.
- Log a warning for rejected fields with `sourceDealId`, `rfpApprovalRequestId`, and field names.

Response:

```ts
{
  success: boolean;
  applied: string[];
  rejected: string[];
}
```

### POST /api/internal/deals/eligibility-check

Purpose: answer SyncHub Phase 4 source-eligibility checks.

Auth:

- Header: `x-rfp-request-signature`.
- Secret: `SYNCHUB_SHARED_SECRET`.
- Verify HMAC SHA-256 against raw body bytes, matching `POST /api/internal/rfp-edits` and the existing body-signed integration pattern.
- Reject invalid signatures with `401`.

Body:

```ts
{
  sourceDealId: string;
}
```

Response:

```ts
// 200
{
  exists: true;
  stage: "opportunity",
  dealId: "crm-deal-uuid"
}
```

If the deal does not exist, return `404`. SyncHub treats `404` as definitively gone and treats `5xx` or network failure as fail-open.

Implementation detail: this endpoint must select the current stage slug by joining `deals.stageId` to the pipeline stage configuration used by `getStageByIdForWorkflowRoute()`, rather than returning the raw `stageId`.

Justification: this keeps the HMAC scheme uniform across SyncHub-to-CRM calls. All internal calls use raw body bytes plus `x-rfp-request-signature`; there is no separate method-plus-path signing convention.

## 7. Editable Field Whitelist for /rfp-edits

Allowed top-level or dotted fields:

- `name`
- `projectNumber`
- `projectType`
- `amount`
- `estimator`
- `companyName`
- `contactName`
- `clientEmail`
- `clientPhone`
- `address.street`
- `address.city`
- `address.state`
- `address.zip`
- `address.country`
- `description`
- `dueDate`
- `workflowRoute`

CRM column mapping:

| Edit field | CRM update |
| --- | --- |
| `name` | `deals.name` |
| `projectNumber` | `deals.dealNumber`; require uniqueness before updating |
| `projectType` | `deals.projectType`; validate through active project type config |
| `amount` | `deals.bidEstimate` while RFP is still pre-Bid Board owned |
| `estimator` | `deals.estimator` |
| `companyName` | joined `companies.name` when `companyId` exists |
| `contactName` | split into joined contact `firstName` and `lastName` only when unambiguous; otherwise reject |
| `clientEmail` | joined contact `email` |
| `clientPhone` | joined contact `phone` |
| `address.street` | `deals.propertyAddress` |
| `address.city` | `deals.propertyCity` |
| `address.state` | `deals.propertyState` |
| `address.zip` | `deals.propertyZip` |
| `address.country` | `deals.propertyCountry` |
| `description` | `deals.description` |
| `dueDate` | `deals.bidDueDate`; convert ISO datetime to `timestamptz` |
| `workflowRoute` | reject unless the deal is still CRM-owned and no Bid Board ownership exists; route changes need stage-gate validation |

Security rule: no wildcard updates. Anything outside this whitelist returns `200` with the field in `rejected`.

## 8. UI Surfacing on the CRM Deal Page

The frontend should render these data states from `rfpApprovalStatus`:

| `rfpApprovalStatus` | Deal page state |
| --- | --- |
| `pending_outbox` | "RFP being sent to approvers" |
| `pending` | "RFP under review" plus token sent timestamp from `rfpApprovalRequestedAt` |
| `approved` | "RFP approved" plus approver email and approved timestamp when Phase 6 callback or later SyncHub status callback stores them |
| `declined` | "RFP declined" plus declined by, declined at, and reason when available |
| `conflict` | Yellow warning with `rfpConflictReason` and a compact `rfpConflictWith` summary |
| `cancelled_source_ineligible` | "RFP cancelled - eligibility check failed" |
| `send_failed` | Red error with `rfpLastAttemptError` and a retry button |

Retry button behavior:

- Find the dead `job_queue` row for this deal with `job_type = "rfp_request_delivery"`, `status = "dead"`, and `payload->>'dealId'` matching the deal id.
- Insert a new `job_queue` row with the same payload, `status = "pending"`, `attempts = 0`, and `runAfter = now()`. Do not mutate the dead row; leave it as audit history.
- Set deal `rfpApprovalStatus = "pending_outbox"` and clear `rfpLastAttemptError`.

This section defines data and state behavior only. Stop 5B can implement a minimal UI surface using the existing deal detail layout.

## 9. Open Questions With Proposed Answers

### What is the exact CRM stage value for Opportunity?

Resolved: the exact stage slug is `opportunity`. It is defined in `shared/src/types/enums.ts:4` and detected in `server/src/modules/deals/stage-change.ts:261`.

### Are there multiple pipelines, and does Opportunity mean the same thing across them?

Yes, there are multiple dispositions: `opportunity`, `deals`, and `service` in `shared/src/types/enums.ts:58`. The code treats `opportunity` as a shared CRM-owned stage that applies to both normal and service deals; `server/src/modules/procore/synchub-routes.ts:27` documents that service deals legitimately enter Opportunity for RFP approval. Proposed answer: trigger RFP for any workflow route entering slug `opportunity`, and use `workflowRoute` only for project type mapping and later stage eligibility.

### What runs the worker?

Reuse the existing custom worker process in `worker/src/index.ts`. It already starts queue polling, cron jobs, and periodic custom jobs. Proposed answer: add a 15-second interval for the RFP request outbox in the existing worker process, and use the same `FOR UPDATE SKIP LOCKED` pattern already used by `worker/src/queue.ts:22`.

### Is `SYNCHUB_SHARED_SECRET` already configured on the CRM side?

I did not find `SYNCHUB_SHARED_SECRET` in the inspected code. Existing related secrets are `BID_BOARD_SYNC_SECRET` for `/api/bid-board-sync/ingest` HMAC (`server/src/modules/bid-board-sync/routes.ts:7`) and `SYNCHUB_INTEGRATION_SECRET` for the older `/api/integrations/synchub` shared-secret route (`server/src/modules/procore/synchub-routes.ts:1`). Proposed answer: add `SYNCHUB_SHARED_SECRET` as a new CRM env var and set it to the same value as SyncHub `RFP_REQUEST_SYNC_SECRET`.

### Does the CRM already have a "deal moved into Opportunity" hook?

Yes. `changeDealStage()` already computes `shouldEmitOpportunityEntered`, writes `rfpApprovalRequestedAt`, `rfpApprovalRequestEventId`, `rfpApprovalRequestedBy`, emits `deal.opportunity.entered`, and inserts a `domain_event` job. Proposed answer: plug the RFP outbox beside this hook rather than adding a second stage-change detector.

### Should the existing `deal.opportunity.entered` domain event worker send the SyncHub request?

Proposed answer: no. Keep `deal.opportunity.entered` as an internal CRM domain event. The SyncHub call should use the new `rfp_request_outbox` table because the required retry, 409 conflict surfacing, token persistence, and user-visible send failure states are integration-delivery concerns tied directly to the originating deal row.
