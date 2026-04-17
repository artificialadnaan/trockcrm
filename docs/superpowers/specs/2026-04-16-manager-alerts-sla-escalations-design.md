# Manager Alerts and SLA Escalations Design

## Goal

Extend the admin-first intervention system with a manager-facing alert loop that turns intervention analytics into actionable daily oversight.

This slice should:

- detect manager-attention conditions deterministically
- surface the current alert state on `/admin/intervention-analytics`
- allow manual preview and explicit send from the analytics page
- send one consolidated morning summary per office in office-local time
- link every alert back into the exact filtered `/admin/interventions` queue

The system must stay grounded in intervention cases and existing office-aware notification infrastructure. This is not a new AI alerting system and should not introduce fuzzy scoring or freeform alert generation.

---

## Existing Context

The current admin-first AI stack already has:

- `/admin/sales-process-disconnects`
  - read-first deterministic disconnect dashboard
- `/admin/interventions`
  - canonical writable queue for case-level intervention actions
- `/admin/intervention-analytics`
  - manager-first oversight of SLA pressure, outcomes, hotspots, and breach queue
- office-aware tenant schemas
  - intervention cases, tasks, notifications, and analytics live inside `office_*` schemas
- worker-driven admin automation
  - disconnect digest
  - disconnect escalation scan
  - admin task generation

Implementation prerequisite:

- this slice assumes the merge target already contains the intervention workspace and intervention analytics work on `main`
- if an implementation branch predates that merged state, it must sync to current `main` before work starts
- this spec extends the current intervention system; it does not reintroduce those earlier slices

The current gap is that managers can inspect the intervention queue and analytics page, but the system does not yet proactively summarize when the queue needs leadership attention.

---

## Problem

Today the platform can show:

- how many intervention cases are open
- which cases are overdue
- which queues are overloaded
- where escalation pressure is building

But it does not yet provide a dedicated manager alert loop that answers:

- what requires management attention right now
- which offices or assignees are slipping first
- whether the manager is seeing the latest pressure snapshot or stale queue state
- how to preview or explicitly send an office summary before scheduled delivery

Without that layer, the analytics page is useful but passive.

---

## Recommended Approach

Build one office-aware manager-alert system that uses deterministic intervention analytics as its source of truth.

V1 should include:

- a `Manager Alerts` panel on `/admin/intervention-analytics`
- a manual preview action
- a manual send action
- one scheduled weekday morning send at `8:00 AM` office-local time
- one consolidated notification per recipient per run

Recipients:

- active `admin`
- active `director`
- current office only

This should reuse:

- intervention case data from `ai_disconnect_cases`
- analytics logic from the intervention analytics service
- tenant notification writes into `office_*.notifications`
- existing worker scheduling conventions

This should not:

- notify reps in v1
- create one notification per individual breach
- add AI-scored urgency
- add recent alert-history UI yet

---

## Alternatives Considered

### 1. Scheduled summary only

Pros:

- smallest scope
- low UI complexity

Cons:

- weak for demos, admin control, and debugging
- no durable management console for current alert state

### 2. Panel only

Pros:

- very safe
- easy to validate

Cons:

- not proactive enough
- depends on managers remembering to check the page

### 3. Recommended: panel + scheduled summary + manual preview/send

Pros:

- strongest management workflow
- easiest to validate safely in preproduction
- gives both proactive delivery and durable visibility

Cons:

- slightly more moving parts
- requires careful dedupe and office-local scheduling rules

---

## Core Design

### Canonical source of truth

Manager alerts are derived from the existing intervention system.

The source of truth for alert conditions is:

- `ai_disconnect_cases`
- existing intervention lifecycle fields
- intervention analytics calculations

Manager alerts do not create a parallel “alert case” state table in v1.

However, v1 does require a small persistent snapshot-state layer so the page can recover:

- latest scan time
- whether the latest snapshot is `preview` or `sent`
- which office the snapshot belongs to
- the normalized payload that was last scanned or sent

So v1 should add a lightweight tenant-scoped latest-snapshot store, not a full alert-history ledger.

Recommended shape:

- one latest snapshot row per office for the logical snapshot kind `manager_alert_summary`
- update-in-place semantics
- no append-only historical table in v1

This keeps alert state recoverable without introducing a second long-term analytics store.

Notification delivery remains an execution artifact, not the canonical state.

### Primary surface

Add a `Manager Alerts` panel to `/admin/intervention-analytics`.

This panel becomes the manager-facing alert console and should show the latest snapshot only.

It should include:

- latest scan time
- whether the latest snapshot is preview-only or sent
- counts by alert family
- top overloaded assignees
- top attention-demanding queue slices
- direct links into `/admin/interventions`
- manual controls:
  - `Run Manager Alert Scan`
  - `Send Alerts`

### Delivery model

Scheduled delivery:

- runs once each weekday
- at `8:00 AM office-local time`
- one consolidated summary notification per recipient per office per run

Manual flow:

- `Run Manager Alert Scan`
  - preview only
  - updates the panel
  - does not create notifications
- `Send Alerts`
  - creates the consolidated notifications immediately
  - respects dedupe

---

## Alert Families

V1 should include exactly these deterministic alert families:

### 1. Overdue high/critical

Conditions:

- intervention case is `open`
- severity is `high` or `critical`
- business-day age exceeds the existing SLA threshold

### 2. Expired snoozes

Conditions:

- intervention case is `snoozed`
- `snoozedUntil < now`

### 3. Unresolved escalations

Conditions:

- intervention case is `escalated`
- case is not `resolved`

### 4. Assignee overload

Conditions:

- assignee has an open-case weighted load above threshold

Weighted score:

- `critical`: `5`
- `high`: `3`
- `medium`: `2`
- `low`: `1`
- add `+2` if escalated
- add `+1` if overdue
- add `+1` if snooze-breached

The overload threshold should be conservative in v1 and explicitly configurable in code.

Recommended default:

- alert when weighted score is `>= 15`

Only include top overloaded assignees in the summary.

---

## Office-Local Scheduling

The send must run in office-local time, not one global timezone.

V1 design:

- use each office’s timezone as the source of truth
- skip inactive offices
- skip offices whose tenant schema does not exist

If the office model does not yet store an explicit timezone field, the implementation should add one to office configuration rather than baking more one-off `America/Chicago` assumptions into worker cron code.

Target send time:

- `8:00 AM` local time

The worker should not create one cron entry per office. Instead, it should:

- run a frequent lightweight scheduler job
- determine which offices are due for their `8:00 AM` send window
- enqueue/send only for due offices

This keeps the system compatible with multiple office timezones.

---

## Notification Model

### Notification shape

One consolidated notification per recipient per office per run.

Title example:

- `Manager Alert Summary: Dallas intervention queue`

Body structure:

1. short narrative line
2. structured metric/count sections
3. top overloaded assignees where applicable
4. plain-text examples only

Narrative style:

- one short sentence only
- operational, not decorative

Example:

- `High-priority intervention pressure needs attention today.`

Sections in the body:

- overdue `high/critical`
- expired snoozes
- unresolved escalations
- assignee overload

Each section should include:

- count
- top 1-3 examples or assignees when applicable

Because tenant notifications support only one `link` field, the notification itself must have one primary target.

Recommended primary notification link:

- `/admin/intervention-analytics`

The notification type must be explicit and schema-backed:

- add a tenant notification enum value: `manager_alert_summary`
- use that exact notification type for these summary notifications

The notification body should summarize the alert families in text, while the analytics page provides the family-specific drill-ins.

### Notification dedupe

Manual sends and scheduled sends must not spam duplicate summaries.

V1 dedupe key:

- office
- recipient
- alert summary type = `manager_alert_summary`
- office-local calendar day

This means:

- scheduled send creates at most one summary notification per recipient per office-local day
- manual `Send Alerts` on the same office-local day should skip if the same summary already exists

Manual `Run Manager Alert Scan` preview does not create notifications and therefore does not consume the dedupe slot.

Implementation note:

- the current notification schema does not provide an idempotency key or unique constraint for this dedupe
- a query-only pre-insert check is not sufficient because manual and scheduled sends can race
- v1 must therefore define a dedicated send-ledger with a unique constraint that enforces one summary notification per recipient per office-local day
- worker and manual send paths must both claim that ledger row before notification insert
- if the ledger claim conflicts, the notification send is suppressed as a duplicate

---

## Manager Alerts Panel

The new panel on `/admin/intervention-analytics` should be read-first and manager-oriented.

It should not mutate intervention cases directly.

### Panel sections

#### 1. Snapshot header

Show:

- latest scan time
- scan mode:
  - preview
  - sent
- office context

#### 2. Alert family cards

Cards for:

- overdue high/critical
- expired snoozes
- unresolved escalations
- assignee overload

Each card should show:

- count
- short descriptor
- link into exact filtered `/admin/interventions`

#### 3. Overloaded assignees

Show top overloaded assignees:

- assignee display name
- weighted load score
- open-case count
- direct queue link filtered by `assigneeId`

#### 4. Priority queue examples

Show a short table or list of:

- top overdue high/critical cases
- top unresolved escalations
- top snooze breaches

Each row should link into the exact queue or detail view.

#### 5. Manual controls

Buttons:

- `Run Manager Alert Scan`
- `Send Alerts`

Behavior:

- scan updates the panel snapshot without creating notifications
- send computes a fresh send snapshot, persists it, and creates notifications if dedupe allows

---

## Queue Linking Rules

Every alert must link to the exact writable queue surface.

All links must go to `/admin/interventions`.

Required filter targets:

- overdue high/critical
  - `/admin/interventions?view=overdue&severity=high`
  - `/admin/interventions?view=overdue&severity=critical`
- expired snoozes
  - `/admin/interventions?view=snooze-breached`
- unresolved escalations
  - `/admin/interventions?view=escalated`
- assignee overload
  - `/admin/interventions?assigneeId=<uuid>`

Where a specific case is called out:

- include `caseId=<uuid>` in the queue link so the matching detail can open immediately

Compatibility note:

- this slice assumes the current intervention workspace contract on `main` supports these filter dimensions
- if the implementation branch lacks any of `overdue`, `snooze-breached`, `severity`, `assigneeId`, or `caseId`, synchronizing to the current merged `main` is required before implementation
- this spec does not require introducing a second queue surface or alternate drill-in route

---

## API and Job Surface

### New AI ops routes

Add manager-alert routes under the existing AI ops namespace.

Recommended endpoints:

- `GET /api/ai/ops/intervention-manager-alerts`
  - returns the latest persisted snapshot for the current office
- `POST /api/ai/ops/intervention-manager-alerts/scan`
  - preview-only scan
- `POST /api/ai/ops/intervention-manager-alerts/send`
  - explicit notification send for the current office

These should require:

- `admin`
- `director`

### New worker job

Add a dedicated job:

- `ai_intervention_manager_alerts`

This job should:

- iterate active offices
- respect office timezone
- skip missing tenant schemas safely
- compute the alert snapshot
- create consolidated notifications if dedupe allows

The same snapshot builder must power:

- `POST /api/ai/ops/intervention-manager-alerts/scan`
- manual preview scan
- manual send
- scheduled worker send

Endpoint semantics:

- `GET`
  - reads the latest persisted snapshot only
  - does not recompute live alert state
- `POST /scan`
  - computes a fresh snapshot
  - persists it as the latest `preview` snapshot
  - returns that persisted preview payload
- `POST /send`
  - computes a fresh snapshot at send time
  - persists it as the latest `sent` snapshot
  - uses that exact persisted sent snapshot as the notification source

---

## Analytics Service Boundary

Do not fork intervention analytics logic into a separate alert calculator that drifts over time.

Recommended boundary:

- a shared service builds the manager-alert snapshot from intervention case state
- `/admin/intervention-analytics` consumes that snapshot
- the worker send job consumes the same snapshot builder
- `GET` reads the latest persisted snapshot rather than recomputing on the fly

This keeps preview, manual send, and scheduled send aligned while making the page recoverable across reloads.

---

## Data Model

V1 should avoid a new persistent alert-history table.

Use:

- current intervention case state
- current analytics snapshot inputs
- existing tenant `notifications`
- one small latest-snapshot persistence layer for recoverable manager-alert UI state

Recommended additions:

- explicit office timezone in office configuration if it is not already reliably present
- a tenant-scoped latest-snapshot table or equivalent lightweight storage for:
  - office id
  - snapshot kind = `manager_alert_summary`
  - snapshot mode (`preview` or `sent`)
  - scanned at
  - sent at
  - normalized snapshot payload
- a tenant-scoped send-ledger table with a unique key on:
  - office id
  - recipient user id
  - office-local calendar day
  - notification type

This table is not an append-only history log. It exists to make preview/send state recoverable across reloads and worker runs.

The send-ledger table is not a rich history surface. It exists to make manual and scheduled delivery idempotent under concurrency.

Canonical snapshot rule:

- `GET /api/ai/ops/intervention-manager-alerts` returns the single latest row for:
  - office id
  - snapshot kind = `manager_alert_summary`
- `snapshotMode` tells the UI whether that latest row came from preview or send
- v1 does not store parallel “latest preview” and “latest sent” rows

---

## Permissions

Only `admin` and `director` should receive manager alerts in v1.

Recipient scoping in v1 is home-office based:

- recipient must be active
- recipient role must be `admin` or `director`
- recipient `users.officeId` must equal the office being processed

V1 does not expand manager alerts to cross-office recipients granted access through `user_office_access`.

Only `admin` and `director` should be able to:

- view the manager alerts panel
- run preview scans
- send alerts manually

No rep-facing manager alerts in v1.

---

## Failure Handling

### Missing schema

If an office tenant schema is missing:

- skip that office
- log a warning
- do not fail the whole run

### No recipients

If an office has no active `admin` or `director` users:

- do not create notifications
- keep preview available if the page is opened by a valid user in that office

### Empty snapshot

If no alert families are active:

- preview panel should show a clean “no manager alerts right now” state
- scheduled send should not create empty notifications

### Duplicate same-day send

If dedupe matches:

- manual `Send Alerts` should return a skipped/suppressed result
- the panel should explain that the office already received today’s alert summary

### Send transaction failure

The send-ledger claim and notification creation must occur in the same database transaction.

Required behavior:

- attempt ledger claim
- insert notification
- commit only if both succeed
- if notification creation fails, roll back the ledger claim so the dedupe slot is not consumed

This ensures a transient failure does not block all retries for the rest of the office-local day.

### Stale branch base

If the implementation branch is missing the already-merged intervention analytics or queue filter contract from `main`:

- sync to current `main` first
- do not reimplement older analytics/workspace primitives inside this slice

---

## Testing Expectations

The implementation must include:

- unit tests for manager-alert snapshot generation
- unit tests for weighted assignee overload scoring
- unit tests for queue-link generation
- route tests for preview and send endpoints
- worker/job tests for:
  - office-local schedule gating
  - dedupe
  - missing-schema skip behavior
  - recipient filtering
- client tests for:
  - panel rendering
  - manual scan flow
  - manual send flow
  - drill-in links

Production validation after merge should cover:

- preview on `/admin/intervention-analytics`
- manual send
- notification receipt in the bell/notification center
- queue drill-ins from all alert families
- scheduled send verification in a controlled office/time test

---

## Non-Goals

V1 should not include:

- rep-facing manager alerts
- afternoon or multi-send daily cadence
- recent alert-history panel
- AI-written long narratives
- fuzzy urgency scoring
- auto-mutation of intervention cases from manager alerts
- email compose/send integration

---

## Success Criteria

This slice is successful when:

- managers can see the current alert snapshot on `/admin/intervention-analytics`
- managers can run a preview scan without sending notifications
- managers can explicitly send a consolidated summary
- weekday scheduled sends happen at `8:00 AM` office-local time
- recipients are only active office `admin` and `director`
- alert links open the exact writable intervention queue state
- dedupe prevents duplicate same-day summary spam
- empty or misconfigured offices do not crash the system

---

## Implementation Areas

Expected primary files:

- `server/src/modules/ai-copilot/intervention-service.ts`
- `server/src/modules/ai-copilot/routes.ts`
- `worker/src/jobs/`
- `worker/src/index.ts`
- `client/src/hooks/use-ai-ops.ts`
- `client/src/pages/admin/admin-intervention-analytics-page.tsx`
- new focused client components under `client/src/components/ai/`
- shared/public office schema/config if timezone support needs to be made explicit
- tenant snapshot-state storage for latest manager-alert snapshot if added in schema

---

## Recommendation

Proceed with a single additive manager-alert slice that:

- extends the current intervention analytics system
- keeps alerts deterministic
- adds one manager panel, one preview flow, one manual-send flow, and one weekday office-local scheduled send

This is the highest-leverage next step because it turns the current intervention system from a manager-readable dashboard into a manager-operated alert loop.
