# T Rock CRM -- Remaining SOW Items Implementation Plan

**Date:** 2026-04-03
**Items:** 8 remaining SOW deliverables
**Estimated total effort:** ~1,800-2,200 lines across ~35 files

---

## Implementation Order (by dependency + priority)

| # | Item | Size | Depends On | Priority |
|---|------|------|-----------|----------|
| 1 | Touchpoint Counter Auto-Increment | Small | None | High |
| 2 | Preset Locked Reports | Trivial | None | High |
| 3 | Change Order Auto-Sync | Small | None | High |
| 4 | Stage Mapping Guardrails | Small-Med | None | High |
| 5 | Touchpoint Alerts / Notifications | Small | #1 | Medium |
| 6 | Follow-Up Reminders Tied to Touchpoints | Small-Med | #1, #5 | Medium |
| 7 | MoM/QoQ/YoY Performance Tracking | Medium | None | Medium |
| 8a | Procore Bi-Dir Sync — Backend Worker | Medium | #3, #4 | Medium |
| 8b | Procore Bi-Dir Sync — Admin Status Page | Medium | #8a | Medium |

**Rationale:** Items 1-4 are independent, high-priority, and unblock later items. Item 1 must land before 5 and 6 (they depend on accurate touchpoint counts). Items 4 and 8a share the `stage-mapping.ts` module — build Item 4 first, then 8a imports from it. Item 8b requires 8a's worker to populate sync state data before the admin UI is useful.

---

## Item 1: Touchpoint Counter Auto-Increment (Small)

### Current State
- `touchpointCount` field exists on `contacts` table (integer, default 0)
- `lastContactedAt` and `firstOutreachCompleted` fields exist
- A PG trigger `touchpoint_trigger` already exists in `migrations/0001_initial.sql` (lines 930-950) that fires AFTER INSERT on `activities` for call/email/meeting types
- The trigger increments `touchpoint_count`, updates `last_contacted_at`, and sets `first_outreach_completed = TRUE`
- `createActivity()` in `server/src/modules/activities/service.ts` has a comment (line 74-77) explicitly stating the PG trigger handles this
- Activity creation route (`activities/routes.ts`) emits `ACTIVITY_CREATED` domain event via job_queue
- Trigger provisioning already exists in `provisionOfficeSchema()`

### Gap Analysis
The PG trigger is **already implemented** in the migration and provisioned via `provisionOfficeSchema()`. The remaining work is verification and backfill for any existing schemas where the trigger may not have fired correctly.

### What to Build
1. **Verification script** checking `pg_trigger` in each `office_*` schema
2. **Backfill migration** for any schemas with missing triggers (idempotent)
3. **Backfill-touchpoint-counts script** to recalculate stale counts from the activities table

### Files to Modify
| File | Change |
|------|--------|
| `scripts/verify-touchpoint-triggers.ts` (NEW) | Query `pg_trigger` in each `office_*` schema and report any missing `touchpoint_trigger` entries |
| `scripts/backfill-touchpoint-counts.ts` (NEW) | One-time script: `UPDATE contacts SET touchpoint_count = (SELECT COUNT(*) FROM activities WHERE contact_id = contacts.id AND type IN ('call','email','meeting'))` per tenant schema |
| `migrations/XXXX_ensure_touchpoint_trigger.sql` (NEW) | Idempotent migration that creates the trigger in any `office_*` schemas where it's missing |

### Implementation Approach
```
1. Write a verification script that queries pg_trigger for each office_*
   schema and logs which ones are missing touchpoint_trigger.

2. Write an idempotent migration that creates the trigger only in schemas
   where it's absent (using DO $$ block with dynamic SQL and EXECUTE format()).
   Skips schemas that already have it.

3. Write a backfill script that recalculates touchpoint_count from the
   activities table for every contact in every tenant schema. Run once.

4. Add a test: create an activity with contactId, verify the contact's
   touchpointCount incremented.
```

### Acceptance Criteria
- [ ] PG trigger exists in all `office_*` schemas
- [ ] Creating a call/email/meeting activity increments `contacts.touchpoint_count`
- [ ] Creating a note activity does NOT increment the count
- [ ] `contacts.last_contacted_at` updates on activity creation
- [ ] `contacts.first_outreach_completed` flips to true on first call/email/meeting
- [ ] Backfill script corrects any stale counts

### Estimated Effort
~80-120 lines across 3 files. Small.

---

## Item 2: Preset Locked Reports (Trivial)

### Current State
- 11 locked reports seeded via `seedLockedReports()` in `saved-reports-service.ts`
- `savedReports` table has `isLocked` and `isDefault` boolean fields
- `updateSavedReport()` already blocks edits: `if (existing.isLocked) throw new AppError(403, "Cannot edit a locked report")`
- `deleteSavedReport()` already blocks deletes on locked reports
- Frontend splits reports into `lockedReports` and `customReports` arrays (line 445-446 of `reports-page.tsx`)
- Locked reports render with a Lock icon badge and use `executeLockedReport()` which hits dedicated server endpoints
- Users CAN currently change the date range and includeDd toggle on locked reports (lines 988-1010 of `reports-page.tsx`)
- **Server endpoints already exist:** `getClosedWonSummary()` at `server/src/modules/reports/service.ts:716` and `getPipelineByRep()` at `:820`
- **Routes already exist:** `GET /reports/closed-won-summary` and `GET /reports/pipeline-by-rep` at `server/src/modules/reports/routes.ts:207-231`

### Gap Analysis
The locked report system is **fully implemented** server-side. The only gap is 2 missing entries in the client `endpointMap` in `client/src/hooks/use-reports.ts` (lines 95-104). Everything else -- server query functions, route handlers, edit/delete protection, UI rendering -- already works.

### What to Build
Add 2 entries to `endpointMap` in `client/src/hooks/use-reports.ts`.

### Files to Modify
| File | Change |
|------|--------|
| `client/src/hooks/use-reports.ts` | Add `closed_won_summary` and `pipeline_by_rep` to `endpointMap` (lines 95-104) |

### Implementation Approach
```
In the endpointMap object (lines 95-104), add:
  closed_won_summary: '/reports/closed-won-summary',
  pipeline_by_rep: '/reports/pipeline-by-rep',
```

### Acceptance Criteria
- [ ] All 11 seeded locked reports are runnable from the UI
- [ ] `closed_won_summary` and `pipeline_by_rep` hit their existing server endpoints
- [ ] Date range controls work for both report types
- [ ] Locked reports cannot be edited or deleted (already works)
- [ ] Lock icon renders on all locked reports (already works)

### Estimated Effort
2 lines, 1 file. Trivial.

---

## Item 3: Change Order Auto-Sync (Small)

### Current State
- `changeOrders` table exists with `procoreCoId`, `dealId`, `coNumber`, `amount`, `status`
- `deals.changeOrderTotal` field exists (numeric, default 0)
- The worker already handles CO sync in `procore-sync.ts`:
  - `syncChangeOrderToCrm()` (line 422-506) upserts COs from Procore and recalculates `change_order_total` as `SUM(amount) WHERE status = 'approved'`
  - `handleProcoreWebhookJob()` (line 264-338) dispatches `change_order.create` and `change_order.update` events to `syncChangeOrderToCrm()`
  - `runProcoreSync()` periodic poll (line 525-615) fetches COs from Procore API and syncs them
- Client has `currentContractValue()` util that sums `awardedAmount + changeOrderTotal`

### Gap Analysis
The auto-sync is **already fully implemented**:
- Webhook path: Procore sends CO webhook -> logged -> job_queue -> `syncChangeOrderToCrm()` -> upsert CO + recalculate `change_order_total`
- Poll path: Every 15 min, worker polls Procore API for COs -> same sync function
- The `change_order_total` on the deal is recalculated every time a CO is synced

**What's missing:** There is no CRM-side CO management (manual CO creation/editing) and no notification when a CO changes the deal value. But the SOW says "automatic value updates when change orders are processed in Procore" -- which IS implemented.

### What to Build
1. Add a notification when `change_order_total` changes on a deal
2. Add CO details to the deal detail page (if not already there)

### Files to Modify
| File | Change |
|------|--------|
| `worker/src/jobs/procore-sync.ts` | After recalculating `change_order_total`, emit a domain event / create notification if the value changed |
| `worker/src/jobs/index.ts` | Register `change_order.synced` domain event handler (if using event pattern) |
| `client/src/pages/deals/deal-detail-page.tsx` | Add a "Change Orders" section showing the CO list and total |
| `client/src/hooks/use-deals.ts` | Add `useChangeOrders(dealId)` hook to fetch COs for a deal |
| `server/src/modules/deals/routes.ts` | Add `GET /api/deals/:id/change-orders` endpoint |

### Implementation Approach
```
1. In syncChangeOrderToCrm(), capture the old change_order_total before
   recalculation. After recalculation, if the value changed, insert a
   notification for the deal's assigned rep:
   "Change order updated: [deal_number] value changed from $X to $Y"

2. Add GET /api/deals/:id/change-orders route that queries the
   change_orders table for the given dealId, ordered by co_number.

3. Add a ChangeOrders section to the deal detail page showing a table:
   CO#, Title, Amount, Status, Approved Date.
   Show the total at the bottom.

4. The existing currentContractValue() util already handles display.
```

### Acceptance Criteria
- [ ] When a CO syncs from Procore, `change_order_total` recalculates (already works)
- [ ] When `change_order_total` changes, the assigned rep gets a notification
- [ ] Deal detail page shows a Change Orders section with CO list
- [ ] CO list shows number, title, amount, status, approved date
- [ ] Total change order value displays on the deal detail page

### Estimated Effort
~150-200 lines across 5 files. Small.

---

## Item 4: Stage Mapping Guardrails (Small-Medium)

### Current State
- `pipelineStageConfig.procoreStageMapping` field exists (varchar, nullable)
- CRM->Procore: `syncDealStageToProcore()` reads the mapping and PATCHes the Procore project
- Procore->CRM: `syncProjectStatusToCrm()` updates `procore_last_synced_at` but does NOT map the Procore stage back to a CRM stage
- SyncHub route: `synchub-routes.ts` receives `stage_slug` from SyncHub and resolves it to a CRM `stageId` via direct lookup at lines 147-154, issuing a raw `UPDATE deals SET stage_id = $1` that bypasses all guardrails
- Stage gate validation: `stage-gate.ts` has `validateStageGate()` -- validates required fields, documents, approvals, backward moves -- but is NOT called from the SyncHub route
- No `deal_stage_history` row is inserted when SyncHub updates a deal's stage
- No domain event is emitted when SyncHub updates a deal's stage

### Gap Analysis
The guardrail is needed in two directions:
1. **Procore->CRM:** When Procore sends a stage/status change, we need to validate that the target CRM stage is a legal transition before applying it
2. **SyncHub->CRM:** The SyncHub route at `synchub-routes.ts:147-154` does a raw `UPDATE deals SET stage_id = $1` that bypasses stage gate validation, skips `deal_stage_history` insertion (no audit trail), and emits no domain event

### What to Build
1. A Procore stage-to-CRM stage reverse mapping lookup
2. Validation in the Procore webhook handler that prevents illegal stage transitions
3. Conflict flagging when Procore tries to push a stage that violates CRM gates
4. **Insert `deal_stage_history` row** when SyncHub updates stage (`changed_by = 'synchub_integration'`)
5. **Emit `deal.stage.changed` domain event** via `job_queue` when SyncHub updates stage
6. **Run stage gate validation** (forward-move only) before applying SyncHub stage update -- reject with 409 if gates not met, log conflict. Reuse existing `validateStageGate()` from `stage-gate.ts` -- do not create a parallel system

**Note:** Items 4 and 8 share the `stage-mapping.ts` module. Build Item 4 first; Item 8 imports from it.

### Files to Modify
| File | Change |
|------|--------|
| `server/src/modules/procore/stage-mapping.ts` (NEW) | Reverse mapping utility: given a Procore stage string, find the CRM `pipelineStageConfig` row with matching `procoreStageMapping` |
| `worker/src/jobs/procore-sync.ts` | In `syncProjectStatusToCrm()`, resolve the Procore stage to a CRM stage. Validate transition legality using display_order rules. If illegal, mark as conflict instead of applying |
| `server/src/modules/procore/synchub-routes.ts` | Replace raw UPDATE at lines 147-154 with: (a) call `validateStageGate()`, (b) insert `deal_stage_history` with `changed_by = 'synchub_integration'`, (c) emit `deal.stage.changed` to `job_queue`, then apply the UPDATE |
| `shared/src/schema/public/pipeline-stage-config.ts` | No change needed -- `procoreStageMapping` already exists |

### Implementation Approach
```
1. Create stage-mapping.ts with:
   - resolveProcoreStage(procoreStage: string): Promise<PipelineStageConfig | null>
     Queries pipeline_stage_config WHERE procore_stage_mapping = $1.
   - isValidTransition(currentStageId: string, targetStageId: string): Promise<boolean>
     Compares display_order. Forward moves always allowed. Backward moves
     flagged as conflict (not auto-applied).

2. In syncProjectStatusToCrm():
   - Extract Procore stage from payload (payload.stage or payload.status)
   - Call resolveProcoreStage() to find the target CRM stage
   - If no mapping found, log and skip (already the behavior for unmapped)
   - If mapped, call isValidTransition(currentDealStageId, targetStageId)
   - If valid: update deal.stage_id, write stage history, emit event
   - If invalid (backward move): mark as conflict in procore_sync_state

3. In synchub-routes.ts (lines 147-154), replace the raw UPDATE with:
   a. Fetch the deal's current stageId
   b. Call validateStageGate() from stage-gate.ts -- reject 409 if not met
   c. Compare display_order: if backward, reject with 409 Conflict
   d. Apply UPDATE deals SET stage_id
   e. INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id,
      changed_at, changed_by = 'synchub_integration')
   f. INSERT INTO job_queue with type = 'domain_event',
      payload = { event: 'deal.stage.changed', dealId, ... }
   - For new deals (no existing deal), skip validation (any stage is fine)
```

### Acceptance Criteria
- [ ] Procore stage changes that map to a valid forward CRM stage transition are applied
- [ ] Procore stage changes that would be a backward move are flagged as conflict
- [ ] Unmapped Procore stages are logged and skipped (no crash)
- [ ] SyncHub pushes that would cause a backward stage move are rejected with 409
- [ ] SyncHub pushes that fail stage gate validation are rejected with 409
- [ ] SyncHub stage updates insert a `deal_stage_history` row with `changed_by = 'synchub_integration'`
- [ ] SyncHub stage updates emit a `deal.stage.changed` domain event via `job_queue`
- [ ] New deals from SyncHub can be created at any stage (no transition check)
- [ ] Conflict records appear in `procore_sync_state` for admin review
- [ ] `validateStageGate()` from `stage-gate.ts` is reused -- no parallel implementation

### Estimated Effort
~200-250 lines across 3 files. Small-medium.

---

## Item 5: Touchpoint Alerts / Notifications (Small)

### Current State
- `firstOutreachCompleted` field on contacts (boolean, default false)
- `getContactsNeedingOutreach()` service function returns contacts with `firstOutreachCompleted = false`
- Daily task worker creates touchpoint tasks for contacts needing outreach (older than 3 days)
- Notification system exists: `notifications` table, `createNotification()` service, SSE push via `sse-manager.ts`, bell icon `NotificationCenter` component
- `NOTIFICATION_TYPES` enum includes: `stale_deal`, `inbound_email`, `task_assigned`, `approval_needed`, `activity_drop`, `deal_won`, `deal_lost`, `stage_change`, `system`
- Contact detail page shows `ContactTouchpointCard` with amber alert when `firstOutreachCompleted` is false

### Gap Analysis
The task creation exists, but there is NO in-app notification (bell icon alert) for contacts needing outreach. The touchpoint card shows a passive amber warning but doesn't create a notification. We need:
1. A new notification type for touchpoint alerts
2. Notification creation when a contact needs outreach
3. A visible alert banner on the contacts list page (not just detail page)

### What to Build
1. Add `touchpoint_alert` to `NOTIFICATION_TYPES`
2. Create notifications in the daily task worker when touchpoint tasks are created
3. Add a contact outreach alert banner to the contacts list page

### Files to Modify
| File | Change |
|------|--------|
| `shared/src/types/enums.ts` | Add `"touchpoint_alert"` to `NOTIFICATION_TYPES` array |
| `migrations/XXXX_add_touchpoint_alert_type.sql` (NEW) | `ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'touchpoint_alert'` for each tenant schema |
| `worker/src/jobs/daily-tasks.ts` | After creating a touchpoint task, also insert a notification for the assigned rep with type `touchpoint_alert` |
| `client/src/components/notifications/notification-center.tsx` | Add `touchpoint_alert` color to `typeColors` map (amber) |
| `client/src/pages/contacts/contacts-list-page.tsx` | Add an alert banner at the top showing count of contacts needing first outreach, with a link to filter by `hasOutreach=false` |

### Implementation Approach
```
1. Add the enum value via migration (one ALTER TYPE per tenant schema +
   public schema). IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside
   a transaction in PostgreSQL < 12. Use the safe idempotent pattern:
     DO $$ BEGIN
       ALTER TYPE notification_type ADD VALUE 'touchpoint_alert';
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$;
   This pattern works in all supported PostgreSQL versions and is safe to
   re-run on already-migrated databases.

2. In daily-tasks.ts, after the touchpoint task INSERT, also INSERT into
   the notifications table:
   - userId = assignedTo
   - type = 'touchpoint_alert'
   - title = "Outreach needed: {firstName} {lastName}"
   - body = "This contact was added {N} days ago and hasn't received first outreach."
   - link = "/contacts/{contactId}"

3. Add the color mapping in notification-center.tsx:
   touchpoint_alert: "bg-amber-500"

4. On the contacts list page, query the count of contacts with
   firstOutreachCompleted = false. If > 0, show an amber banner:
   "{N} contacts need first outreach" with a "View" button that sets
   the hasOutreach=false filter.
```

### Acceptance Criteria
- [ ] `touchpoint_alert` notification type exists in the DB enum
- [ ] Daily task job creates both a task AND a notification for contacts needing outreach
- [ ] Notification appears in the bell icon dropdown with amber dot
- [ ] Clicking the notification navigates to the contact detail page
- [ ] Contacts list page shows an alert banner when contacts need outreach
- [ ] Banner links to the filtered view (hasOutreach=false)

### Estimated Effort
~120-160 lines across 5 files. Small.

---

## Item 6: Follow-Up Reminders Tied to Touchpoints (Small)

### Current State
- Daily task worker creates follow-up tasks for deals with `expected_close_date` within 7 days
- Daily task worker creates touchpoint tasks for contacts needing first outreach
- Tasks have `type` enum including `follow_up` and `touchpoint`
- Tasks can have `dealId` and `contactId` associations
- No linkage between follow-up task triggers and contact touchpoint milestones

### Gap Analysis
Follow-ups are only triggered by deal close dates, not by contact touchpoint milestones. The SOW wants reminders tied to:
1. Deal stage + touchpoint cadence (e.g., "contact every 2 weeks while in Estimating stage")
2. Contact touchpoint milestones (e.g., "follow up after 5th touchpoint" or "re-engage if no touchpoint in 14 days")

### What to Build
1. A touchpoint cadence configuration per pipeline stage
2. Worker logic to create follow-up tasks when contacts fall behind their cadence
3. Worker logic to detect contacts with no recent touchpoint relative to their deal stage

### Files to Modify
| File | Change |
|------|--------|
| `shared/src/schema/public/pipeline-stage-config.ts` | Add `touchpointCadenceDays` column (integer, nullable) -- how often contacts on deals in this stage should be touched |
| `migrations/XXXX_add_touchpoint_cadence.sql` (NEW) | `ALTER TABLE pipeline_stage_config ADD COLUMN touchpoint_cadence_days INTEGER` |
| `worker/src/jobs/daily-tasks.ts` | Add Step 4: query contacts linked to active deals where `last_contacted_at` is older than the stage's `touchpoint_cadence_days`. Create follow-up tasks |
| `server/src/modules/pipeline/routes.ts` | Ensure pipeline config admin endpoint returns and accepts `touchpointCadenceDays` |
| `client/src/pages/pipeline/pipeline-config-page.tsx` | Add touchpoint cadence field to the stage config editor |

### Implementation Approach
```
1. Add touchpoint_cadence_days to pipeline_stage_config (nullable integer).
   Example values: DD=null (no cadence), Estimating=14, Proposal=7, Award=3.

2. In daily-tasks.ts, add a new Step 4 after the existing Step 3:

   Query: SELECT contacts linked to active deals (via contact_deal_associations)
   WHERE the deal's stage has touchpoint_cadence_days IS NOT NULL
   AND contacts.last_contacted_at < CURRENT_DATE - touchpoint_cadence_days
   AND no existing pending/in_progress follow_up task for this contact+deal combo.

   NOTE: pipeline_stage_config lives in the public schema while contacts,
   deals, and activities live in the office_* tenant schema. The daily-task
   query must use a fully-qualified reference: public.pipeline_stage_config
   in the JOIN/WHERE clause to avoid "relation does not exist" errors when
   executing under the tenant schema search path.

   For each result, create a follow_up task:
   - title: "Touchpoint overdue: {contact_name} on {deal_number}"
   - type: "follow_up"
   - assigned_to: deal.assigned_rep_id
   - deal_id: deal.id
   - contact_id: contact.id
   - due_date: CURRENT_DATE
   - priority: "high"

3. Also create a touchpoint_alert notification for the rep.

4. Wire up the pipeline config admin UI to display/edit the cadence field.
```

### Acceptance Criteria
- [ ] `touchpoint_cadence_days` column exists on `pipeline_stage_config`
- [ ] Pipeline config admin page allows setting cadence per stage
- [ ] Daily worker creates follow-up tasks when a contact's last touchpoint exceeds the cadence
- [ ] Tasks are deduped (no duplicate follow-up for same contact+deal)
- [ ] Rep receives a notification for each overdue touchpoint
- [ ] Stages with null cadence are skipped (no tasks created)

### Estimated Effort
~200-250 lines across 5 files. Small-medium.

---

## Item 7: MoM/QoQ/YoY Performance Tracking (Medium)

### Current State
- `getWinRateTrend()` returns monthly wins/losses/winRate -- but combined across all reps (per-rep only via optional `repId` param)
- Director dashboard shows: rep cards (current metrics), pipeline by stage, win rate trend (monthly all-reps), activity by rep, stale deals
- Rep dashboard shows: active deals, tasks today, activity this week, follow-up compliance, pipeline by stage
- No period-over-period comparison exists anywhere
- `deal_stage_history` tracks every stage change with timestamps -- raw data for historical analysis

### Gap Analysis
Need to build:
1. **MoM metrics per rep:** Compare current month vs previous month for key KPIs (deals won, pipeline value, activity count, win rate)
2. **QoQ metrics per rep:** Same but quarter-over-quarter
3. **YoY metrics per rep:** Same but year-over-year
4. **Director dashboard integration:** Period comparison view on the director dashboard
5. **Rep dashboard integration:** "Your performance vs last period" card

### What to Build
1. A new `getRepPerformanceComparison()` service function
2. A new API endpoint for period comparison data
3. Director dashboard "Performance Trends" section
4. Rep dashboard "Your Trend" card

### Files to Modify
| File | Change |
|------|--------|
| `server/src/modules/reports/service.ts` | Add `getRepPerformanceComparison(tenantDb, repId?, period)` function that calculates current vs previous period metrics |
| `server/src/modules/reports/routes.ts` | Add `GET /reports/performance-comparison?period=mom|qoq|yoy&repId=` |
| `server/src/modules/dashboard/service.ts` | Add `getRepPerformanceTrend(tenantDb, repId, periods)` that returns an array of period metrics for sparkline rendering |
| `server/src/modules/dashboard/routes.ts` | Add `GET /api/dashboard/performance-trend?repId=&period=mom|qoq|yoy` |
| `client/src/hooks/use-performance-comparison.ts` (NEW) | Hook to fetch comparison data |
| `client/src/components/charts/performance-comparison-chart.tsx` (NEW) | Bar chart component showing current vs previous period side-by-side |
| `client/src/pages/director/director-dashboard-page.tsx` | Add performance comparison section with period selector |
| `client/src/pages/dashboard/rep-dashboard-page.tsx` | Add "Your Trend" KPI card with delta indicators |

### Implementation Approach
```
1. getRepPerformanceComparison(tenantDb, options):
   Accepts: period ('mom'|'qoq'|'yoy'), optional repId
   Calculates date ranges for current and previous period:
   - mom: current month vs previous month
   - qoq: current quarter vs previous quarter
   - yoy: current year vs previous year

   For each period, queries:
   - Deals won count (from deal_stage_history WHERE to_stage closed_won)
   - Deals lost count
   - Win rate
   - Total activities logged
   - Average days to close

   NOTE: Pipeline value snapshot comparison is impossible with the current
   data model -- there is no historical pipeline value snapshot table, so
   "pipeline value in Q1 vs Q2" cannot be reconstructed. MoM/QoQ/YoY must
   focus on: deals won, deals lost, activities logged, win rate, avg days
   to close. For pipeline value, use "deals entering pipeline in period"
   (i.e. deals created within the date window) with clear UI labeling such
   as "New deals entered" to avoid misleading users into thinking it
   represents total pipeline value at that point in time.

   Returns: {
     current: { period, dealsWon, dealsLost, winRate, revenue, activities, avgDaysToClose },
     previous: { ... same shape ... },
     deltas: { dealsWon: +/-N, winRate: +/-N%, revenue: +/-$N, ... }
   }

2. Per-rep variant: same query but filtered by assigned_rep_id.

3. Director dashboard: Add a "Performance Trends" card with a period
   toggle (MoM/QoQ/YoY). Show a table of reps with current vs previous
   metrics and delta indicators (green up arrow, red down arrow).

4. Rep dashboard: Add a compact "Your Trend" card showing 3-4 KPIs
   with delta badges. Default to MoM.

5. Performance comparison chart: Side-by-side bar chart (current=red,
   previous=gray) for key metrics. Reusable component.
```

### Acceptance Criteria
- [ ] API returns current-vs-previous period data for MoM, QoQ, YoY
- [ ] Per-rep filtering works (single rep or all reps)
- [ ] Director dashboard shows performance comparison table with period toggle
- [ ] Delta indicators show positive (green) and negative (red) trends
- [ ] Rep dashboard shows a "Your Trend" card with MoM deltas
- [ ] Chart component renders current vs previous side-by-side
- [ ] Empty periods (no data) show "N/A" rather than 0

### Estimated Effort
~400-500 lines across 8 files. Medium.

---

## Item 8a: Procore Bi-Directional Sync — Backend Worker (Medium)

**Depends on:** Item 4 (shares `stage-mapping.ts`). Build Item 4 first.

### Current State
- **CRM->Procore (implemented):**
  - `deal.won` event -> worker creates Procore project
  - `deal.stage.changed` event -> worker updates Procore project stage
  - Uses `procoreStageMapping` from pipeline config
- **Procore->CRM (partially implemented):**
  - Webhook route receives Procore events, logs them, dispatches to job_queue
  - `project.update` handler: updates `procore_last_synced_at` on deal, detects conflicts -- but does NOT update the CRM deal's stage
  - `change_order.create/update` handler: fully syncs COs (implemented in item 3)
  - Periodic poll: fetches project details + COs every 15 min, runs same handlers
- **Conflict detection (implemented):**
  - `procore_sync_state` tracks last sync time per entity
  - If both CRM and Procore changed since last sync, marks as conflict
- **What's missing from Procore->CRM:**
  - Stage reverse-mapping (Procore stage -> CRM stage)
  - Actual deal stage update from Procore events
  - Deal field sync (name, address changes in Procore flowing back)

### Gap Analysis
The webhook infrastructure and conflict detection are built. The missing piece is the actual data application -- when a Procore project.update event comes in, we need to map the Procore stage to a CRM stage, update the deal's stage_id with audit history, sync other fields, and emit domain events.

**Ambiguous reverse mapping:** Multiple CRM stages may map to the same Procore stage string (e.g. both "Estimating" and "Estimating - Final" might map to Procore's `"Active"`). When `resolveProcoreStage()` returns more than one result, do not auto-apply -- log the ambiguity as a conflict and require admin resolution.

### What to Build
1. Complete `syncProjectStatusToCrm()` to actually update deal stage
2. Import reverse stage mapping from `stage-mapping.ts` (built in item 4)
3. Add field-level sync for project name and address
4. Handle ambiguous reverse mappings (multiple CRM stages -> one Procore stage) as conflicts

### Files to Modify
| File | Change |
|------|--------|
| `server/src/modules/procore/stage-mapping.ts` | (Already created in item 4) Add `findCrmStageByProcoreMapping()` -- return array to surface ambiguous mappings |
| `worker/src/jobs/procore-sync.ts` | Enhance `syncProjectStatusToCrm()` to: resolve Procore stage -> CRM stage, handle ambiguous mappings, validate transition, update deal.stage_id + deal_stage_history, emit events. Also add field sync for name/address |
| `worker/src/jobs/index.ts` | Register `procore.project.updated` domain event handler |
| `server/src/modules/procore/sync-service.ts` | Add `syncProcoreFieldsToDeal()` utility for field-level sync |

### Implementation Approach
```
1. Enhance syncProjectStatusToCrm() in procore-sync.ts:

   a. Extract Procore stage from payload (payload.stage)
   b. Call resolveProcoreStage(procoreStage) -- returns PipelineStageConfig[]
   c. If no mapping found, log and skip
   d. If multiple mappings found (ambiguous), mark as conflict in
      procore_sync_state and skip -- do not guess which CRM stage to use
   e. If exactly one mapping, fetch current deal stage:
      - If same stage, skip (already in sync)
      - If different, check isValidTransition()
      - If valid forward move: UPDATE deals SET stage_id, stage_entered_at
        INSERT INTO deal_stage_history (changedBy = 'procore_sync')
        INSERT INTO job_queue domain_event for deal.stage.changed
      - If invalid (backward move): mark as conflict, don't apply

   f. Sync fields: if payload.name differs from deal.name, update.
      If payload.address/city/state/zip differ, update.
      Only apply if no CRM-side changes since last sync (conflict check).

2. Add a 'procore_sync' system actor constant for changedBy in
   deal_stage_history so the audit trail distinguishes Procore-initiated
   changes from human user changes.

3. Emit notifications for:
   - Successful reverse sync: "Deal {number} stage updated from Procore"
   - Conflicts: "Sync conflict on {deal_number} -- manual review needed"
```

### Acceptance Criteria
- [ ] Procore project stage changes are mapped to CRM stages and applied
- [ ] Stage changes respect the guardrails from item 4 (no illegal transitions)
- [ ] Ambiguous reverse mappings (multiple CRM stages -> one Procore stage) are flagged as conflicts, not auto-applied
- [ ] Conflicts are detected and flagged (not auto-applied)
- [ ] Deal stage history shows `changedBy = 'procore_sync'` for Procore-initiated changes
- [ ] Field changes (name, address) sync from Procore to CRM
- [ ] Notifications fire for both successful syncs and conflicts
- [ ] Existing CRM->Procore sync continues to work (no regression)

### Estimated Effort
~200-300 lines across 4 files. Medium.

---

## Item 8b: Procore Bi-Directional Sync — Admin Sync Status Page (Medium)

**Depends on:** Item 8a (needs the sync state data populated by the worker).

### What to Build
Admin UI page showing Procore sync state: totals, conflicts, recent events, and a resolution flow.

### Files to Modify
| File | Change |
|------|--------|
| `server/src/modules/admin/routes.ts` (or new sync admin route) | Add `GET /api/admin/procore-sync-status` endpoint returning sync state overview |
| `client/src/pages/admin/procore-sync-page.tsx` (NEW) | Admin page showing sync state table: entity, direction, status, last synced, conflicts |

### Implementation Approach
```
1. Admin sync status endpoint:
   - Query procore_sync_state grouped by sync_status
   - Return: total synced, total conflicts, total errors, recent events

2. Admin sync status page:
   - Summary cards: total synced, conflicts, errors
   - Table of recent sync events with filters (status, direction, date range)
   - "Resolve Conflict" button that lets admin choose CRM or Procore version
   - Conflict resolution writes the chosen value and clears the conflict flag
```

### Acceptance Criteria
- [ ] Admin page shows sync status overview with conflict count
- [ ] Table shows recent sync events filterable by status and direction
- [ ] Conflict resolution UI lets admin choose CRM or Procore version
- [ ] Resolving a conflict clears the conflict flag in `procore_sync_state`

### Estimated Effort
~300-400 lines across 2 files. Medium.

---

## Cross-Cutting Concerns

### Migration Order
Migrations must be applied in this order to avoid enum/column dependency issues:
1. `XXXX_ensure_touchpoint_trigger.sql` (item 1)
2. `XXXX_add_touchpoint_alert_type.sql` (item 5) — use `DO $$ BEGIN ALTER TYPE ... ADD VALUE ...; EXCEPTION WHEN duplicate_object THEN NULL; END $$` pattern; `ALTER TYPE ... ADD VALUE` cannot run inside a transaction in older PostgreSQL
3. `XXXX_add_touchpoint_cadence.sql` (item 6)

Items 2, 3, 4, 7, 8a, 8b have no migration dependencies on each other.

### Shared Code
- Items 4 and 8a share the `stage-mapping.ts` module — Item 4 creates it, Item 8a imports from it. Build sequentially.
- Items 5 and 6 both create notifications via the daily task worker
- Items 1, 5, and 6 all involve the touchpoint system

### Testing Strategy
Each item should include:
- Unit tests for new service functions
- Integration tests for new API endpoints
- Worker job tests (mock DB, verify correct queries)
- Frontend: manual verification of new UI components

### Notification Types Added
| Type | Item | Description |
|------|------|-------------|
| `touchpoint_alert` | #5 | Contact needs first outreach |
| (reuse `stage_change`) | #8a | Deal stage changed via Procore sync |
| (reuse `system`) | #3 | Change order value changed |
| (reuse `system`) | #8a | Sync conflict detected |

---

## Summary Table

| Item | Files to Create | Files to Modify | Est. Lines | Complexity |
|------|----------------|-----------------|-----------|------------|
| 1. Touchpoint Counter | 2 | 1 | 80-120 | Small |
| 2. Preset Locked Reports | 0 | 1 | 2 | Trivial |
| 3. Change Order Auto-Sync | 0 | 5 | 150-200 | Small |
| 4. Stage Mapping Guardrails | 1 | 2 | 200-250 | Small-Med |
| 5. Touchpoint Alerts | 1 | 4 | 120-160 | Small |
| 6. Follow-Up Reminders | 1 | 4 | 200-250 | Small-Med |
| 7. MoM/QoQ/YoY Tracking | 2 | 6 | 400-500 | Medium |
| 8a. Procore Sync — Worker | 0 | 4 | 200-300 | Medium |
| 8b. Procore Sync — Admin UI | 1 | 1 | 300-400 | Medium |
| **TOTAL** | **8** | **~28** | **1,652-2,182** | |
