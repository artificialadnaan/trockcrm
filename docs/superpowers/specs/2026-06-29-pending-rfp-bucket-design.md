# Pending RFP Bucket — Design Spec

**Date:** 2026-06-29
**Status:** Approved design, pre-implementation
**Approach:** B — derived bucket (no new pipeline stage)

## Problem

When an RFP is triggered on an Opportunity deal but not yet approved, the deal
**stays in the Opportunity stage** with only a status badge. There is no distinct
place for "triggered, awaiting approval" deals, so they get overlooked — a deal can
sit silently waiting on RFP approval (or after a decline) with no one noticing.

We want a visible **"Pending RFP"** bucket that sits conceptually between Opportunity
and Estimating/Service Estimating, where RFP-triggered deals live until the RFP is
approved — acting as a shared "pending RFP dashboard" visible to everyone.

## Current system (grounding)

- **Stages** are rows in the global `public.pipeline_stage_config` table, referenced by
  `deals.stage_id`. Canonical order/contracts live in `shared/src/types/workflow.ts`
  (`CANONICAL_DEAL_STAGE_SLUGS`, `CANONICAL_DEAL_WORKFLOW_CONTRACTS`). Active order:
  **Opportunity → Estimating (normal route) / Service Estimating (service route) →
  Estimate Under Review → Estimate Sent to Client → Contract → Won/Lost.** There is **no
  stage between Opportunity and Estimating.**
- **Trigger RFP** — `POST /deals/:id/trigger-rfp` (`server/src/modules/deals/routes.ts:1187`)
  and `enqueueOpportunityRfpIfNeeded` (`server/src/modules/deals/rfp-enqueue.ts:182`) set
  `rfp_approval_status = 'pending_outbox'` + the RFP request columns and **leave
  `stage_id = opportunity`** (no stage change). Requires current stage == opportunity.
- **Approved** — SyncHub callback `POST /internal/bid-board-created`
  (`server/src/modules/internal-rfp/routes.ts:626`) sets `rfp_approval_status='approved'`,
  `is_bid_board_owned=true`, and **advances the stage** to `estimating`/`service_estimating`
  (via `bidBoardCreatedTargetStageSlug`, forward-only).
- **Declined** — `POST /internal/rfp-declined` → `applyRfpDeclineToDeal`
  (`server/src/modules/deals/rfp-decline-service.ts:20`) sets `rfp_approval_status='declined'`
  and **stays in Opportunity**, flagged.
- **Board** — `client/src/components/pipeline/pipeline-board.tsx` renders one column per
  entry from `buildCanonicalDealBoardColumns` (`client/src/lib/canonical-deal-board.ts`),
  route-aware. Board data comes from `GET /deals/pipeline` (`getDealsForPipeline`), which is
  **owner-scoped for reps**.

**Net:** "RFP triggered, awaiting approval" deals are exactly
`stage = opportunity` AND `rfp_approval_status ∈ {pending_outbox, pending}` (plus
`declined`/`failed`/`conflict` for ones needing attention), AND `is_bid_board_owned = false`.
This is a clean, well-defined set to build the bucket from with **no schema change**.

## Approach

**B — derived bucket.** The deal keeps `stage_id = opportunity`. "Pending RFP" is a
**view** over existing data, surfaced as a synthetic board column plus a dedicated
dashboard. The existing trigger/approve/decline logic already produces the correct
underlying state, so we change **no** transition, stage-gate, reporting, or terminal logic
and add **no migration**. Wait-time comes from `rfp_approval_requested_at` (the true
"waiting since").

Rejected alternative — **A, a real `pending_rfp` pipeline stage**: cleaner data model and
shows up in stage-grouped reports, but high blast radius across the canonical workflow
contracts, both route pipelines, stage-gate, every report/query keyed on stage slugs,
transitions, and a migration. Deferred; B can be promoted to A later if reporting demands.

## Requirements (from scoping)

- **Bucket predicate (single source of truth):** a deal is "Pending RFP" iff
  `stage = opportunity` AND `is_bid_board_owned = false` AND
  `rfp_approval_status ∈ {pending_outbox, pending, declined, conflict, send_failed}`.
  (Note: the codebase stores the failed-delivery status as **`send_failed`**, not `failed`;
  `approved` leaves the bucket via the stage advance; `cancelled_source_ineligible` is a
  terminal cancellation and is **excluded**.)
  - **Awaiting approval** sub-state = `{pending_outbox, pending}`
  - **Needs attention** sub-state = `{declined, conflict, send_failed}`
- **Auto-entry** the moment an RFP is triggered; **auto-exit** on approval (deal advances to
  Estimating/Service Estimating). **Declined/failed/conflict stay** in the bucket, flagged.
- **Two surfaces:** (1) a synthetic column on the deals pipeline board, right after
  Opportunity; (2) a dedicated shared **Pending RFP dashboard** page.
- **Visibility:** office-scoped, **cross-rep** — everyone in the office sees all pending-RFP
  deals (a shared queue). This is intentionally broader than the rest of the board, which is
  owner-scoped for reps.
- **Escape hatch:** a **"Return to Opportunity (cancel pending RFP)"** action that clears the
  RFP request fields so the deal drops back to plain Opportunity (so the bucket doesn't
  accumulate dead declined deals). Permissions: **director/admin or the owning rep.**

## Components

### 1. Shared predicate helper (single source of truth)

A single helper defining bucket membership + sub-state, used by the read endpoint, the
board's Opportunity-column exclusion, and any count badge — so they cannot drift
(reconciliation-consistency rule).

- Named status constants: `PENDING_RFP_STATUSES = [pending_outbox, pending, declined, conflict, send_failed]`,
  `PENDING_RFP_AWAITING_STATUSES = [pending_outbox, pending]`,
  `PENDING_RFP_ATTENTION_STATUSES = [declined, conflict, send_failed]`.
- `isPendingRfp(deal)` (membership) and `pendingRfpSubState(deal)` (`'awaiting' | 'attention'`),
  plus a SQL predicate builder for queries. Placed in `shared/` (so client and server share it)
  with the SQL builder in the server deals module.

### 2. Read endpoint — `GET /deals/pending-rfp`

- **Office-scoped, cross-rep** (tenant + office middleware; **no owner filter**).
- Excludes test data and soft-deleted (`is_active = false`), consistent with other deal queries.
- Returns each pending-RFP deal with: `id`, `name`, `projectNumber`, `dealNumber`,
  `ownerRep {id, name}`, `workflowRoute`, `rfpApprovalStatus`, `subState`
  (`awaiting`/`attention`), `triggeredBy {id, name}` (from `rfp_approval_requested_by`),
  `triggeredAt` (`rfp_approval_requested_at`), `ageDays`, and `declineReason` (when declined).
- Sorted **oldest-first** (`triggeredAt` asc) so the most-overlooked surfaces at the top.
- Uses the shared predicate's SQL builder.

### 3. Pipeline-board column

- Insert a synthetic **"Pending RFP"** column right after Opportunity (route-aware: before
  Estimating / Service Estimating), in `buildCanonicalDealBoardColumns`
  (`client/src/lib/canonical-deal-board.ts`).
- The **Opportunity column excludes** deals matching the predicate (so they're not
  double-shown), and the Pending RFP column is populated from the shared **cross-rep**
  pending-RFP set.
- **Recommended wiring:** assemble the column **server-side** in the board response (the
  board endpoint adds the cross-rep Pending RFP column and excludes those deals from
  Opportunity), to avoid client-side dedup between the owner-scoped board and the cross-rep
  set. Final wiring decided in the plan.
- Each card shows a status badge (Awaiting / Declined / Failed). Column header shows a count
  (from the shared predicate). The column is **informational** — no drag-in/drag-out (it's
  status-driven, not a real stage). Clicking a card opens the deal.

### 4. Dashboard page

- New nav-linked route (e.g. `/pending-rfp`), visible to all roles.
- Shared-queue table: **deal** (name + project #), **rep**, **route**, **status** (sub-state
  badge), **triggered-by**, **waiting-since** (age; highlighted past a staleness threshold),
  **decline reason**. Sorted oldest-first. Row → deal detail.
- Staleness highlight threshold: **`PENDING_RFP_STALE_DAYS = 2`** calendar days (tunable
  constant); deals at/over the threshold render highlighted (red) to surface overlooked ones.

### 5. Escape-hatch action — `POST /deals/:id/cancel-rfp`

- Clears the RFP request fields (`rfp_approval_requested_at`, `rfp_approval_status`,
  `rfp_approval_request_event_id`, `rfp_approval_requested_by`, decline fields) so the deal
  returns to **plain Opportunity** (predicate stops matching).
- **Guards:** only when `stage = opportunity`, `is_bid_board_owned = false`, and a pending/declined
  RFP exists. **Permissions:** director/admin or the owning rep. Writes `deal_history` + audit.
- **UI:** a "Return to Opportunity" button on the deal detail page (shown while the deal is in a
  pending-RFP state) and a row action on the dashboard.
- Re-triggering a declined deal continues to use the **existing override/re-trigger flow**
  (`server/src/modules/deals/rfp-override-service.ts`) — out of scope to change here.

### 6. Lifecycle (no transition-logic changes)

| Event | `rfp_approval_status` | `stage` | In Pending RFP? |
|---|---|---|---|
| Trigger RFP | `pending_outbox` → `pending` | opportunity | **Yes** (Awaiting) |
| Approved (bid-board-created) | `approved` | estimating / service_estimating | No → Estimating |
| Declined | `declined` | opportunity | **Yes** (Needs attention) |
| Failed / conflict | `failed` / `conflict` | opportunity | **Yes** (Needs attention) |
| Cancel RFP (escape hatch) | cleared | opportunity | No → plain Opportunity |

## Edge cases

- **Deal manually moved out of Opportunity while pending:** predicate requires `opportunity`,
  so it drops out of the bucket (acceptable; rare).
- **Bid-board-owned but status still pending** (shouldn't happen): predicate requires
  `is_bid_board_owned = false`, so it's excluded.
- **Count-badge / column-count consistency:** every count uses the shared predicate.
- **Own vs others' deals:** a rep's own pending-RFP deals appear in the (cross-rep) Pending RFP
  column and are excluded from their Opportunity column; other reps' pending-RFP deals appear
  only in the Pending RFP column/dashboard.

## Testing

- **Server:** predicate helper unit tests (each status → membership + sub-state);
  `GET /deals/pending-rfp` (cross-rep, office-scoped, sorting oldest-first, field shape,
  excludes test/inactive); `POST /deals/:id/cancel-rfp` (permission matrix, guards, clears
  fields, writes history).
- **Client:** `canonical-deal-board` adds the Pending RFP column and excludes those deals from
  Opportunity; dashboard renders rows + staleness highlight; escape-hatch action visibility by
  role.

## Out of scope (v1)

- Making it a real pipeline stage (Approach A).
- Any change to trigger / approve / decline logic.
- Cross-*office* visibility (office-scoped only).
- Proactive notifications/alerts for stale pending RFPs (possible future follow-up).

## Decisions locked for the plan

- Predicate statuses: `{pending_outbox, pending, declined, conflict, send_failed}`; sub-states as above.
- Visibility: office-scoped, cross-rep, for both the column and the dashboard.
- Escape hatch in v1; permissions director/admin or owning rep.
- Staleness threshold default `PENDING_RFP_STALE_DAYS = 2` (tunable).
- Endpoint names: `GET /deals/pending-rfp`, `POST /deals/:id/cancel-rfp`.
- Board column wiring: **client-merge** — the board page passes the `/deals/pending-rfp`
  data to `buildCanonicalDealBoardColumns`, which renders the cross-rep "Pending RFP" column
  and excludes those deals from Opportunity. No change to the board endpoint/service.
