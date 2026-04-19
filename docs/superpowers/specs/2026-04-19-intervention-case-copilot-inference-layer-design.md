# Intervention Case Copilot and Inference Layer

## Goal

Add an embedded, advisory-only Case Copilot to the existing intervention workspace so admins and directors can understand a case faster, choose better actions, and learn from similar historical outcomes without adding any new top-level page, sidebar entry, or menu-bar tab.

## Product Shape

This slice does **not** create a new route. It extends the existing intervention execution surface:

- primary surface: `/admin/interventions`
- insertion point: `InterventionDetailPanel`

The copilot appears as an additional advisory block inside the existing detail sheet. It must not add:

- a new sidebar destination
- a new page-level route
- a new tab in the top menu or admin navigation

## Problem

The current intervention workspace is strong on deterministic execution:

- queue filtering
- batch actions
- detail actions
- history
- structured outcome capture

But it still leaves the hardest judgment work to the human:

- why this case is really risky now
- what action is most likely to work next
- whether similar cases tended to reopen
- whether the current assignee/owner context looks wrong

Today the user can read the case and history, but the system does not synthesize those signals into a clear, explainable recommendation.

## Desired Outcome

For any intervention case opened in the detail panel, the user should be able to see:

1. a short copilot brief
2. a single recommended next action
3. explicit confidence
4. likely root-cause / blocker framing
5. reopen-risk framing
6. similar historical cases and what happened to them
7. evidence used for the recommendation

All of that must be advisory only. Users still take the actual actions through the existing deterministic controls.

## Scope

In scope:

- intervention-scoped copilot view in the detail sheet
- intervention-scoped copilot API
- reuse of existing AI packet infrastructure where practical
- safe heuristic fallback when external model inference is unavailable
- similar-case retrieval from intervention history/current case data
- packet feedback capture for usefulness / not useful
- manual refresh of the intervention copilot packet

Out of scope:

- autonomous case mutation
- auto-resolve / auto-snooze / auto-escalate
- auto-assigning owners
- new sidebar groups or page navigation
- broad manager-console changes
- recommendation promotion/rule rollout

## UI Placement

### Existing Detail Sheet

`InterventionDetailPanel` currently contains:

- case summary
- generated task section
- direct actions
- case history

Case Copilot should be inserted **between** the case summary block and the generated-task block.

Reasoning:

- the brief should be visible before action controls
- it should frame the user’s decision-making before they reach resolve/snooze/escalate
- it should not be visually more prominent than the case itself

### Visual Structure

The new panel should feel like part of the existing detail sheet, not a new mini-app.

Required sections:

1. `Case Copilot` header row
   - title
   - confidence badge
   - generated/updated timestamp
   - refresh button
   - packet status badge if refresh is pending

2. `Case Brief`
   - short summary paragraph

3. `Recommended Next Action`
   - single recommendation card
   - includes action label, rationale, and suggested owner if available

4. `Risk + Root Cause`
   - likely root-cause framing
   - likely blocker owner/context
   - reopen-risk indicator

5. `Similar Historical Cases`
   - compact list of similar cases
   - outcome summary for each
   - durable close / reopen signal
   - deep link back into the workspace if the case still exists

6. `Evidence`
   - concise source list
   - no giant JSON blobs in the visible UI

7. `Feedback`
   - `Useful`
   - `Not useful`

No extra tabs inside the detail sheet. This stays a single vertically stacked advisory module.

## Inference Model

### Advisory Only

Case Copilot does not own state changes.

Deterministic controls remain canonical for:

- assign
- snooze
- resolve
- escalate

The copilot only helps the user decide which of those actions is most appropriate.

### What the Copilot May Infer

The copilot may infer:

- likely root cause
- likely blocker owner
- best next action
- whether the case resembles a repeat-failure pattern
- whether a snooze would likely be weak
- whether escalation has historically worked for similar cases
- likely reopen risk

The copilot must not present these as facts. It should present them as evidence-backed suggestions with confidence.

## Data Model

### Reuse Existing Packet Infrastructure

Reuse the current tenant AI packet stack:

- `ai_copilot_packets`
- `ai_task_suggestions`
- `ai_risk_flags`
- `ai_feedback`

New packet scope:

- `scopeType = "intervention_case"`
- `scopeId = <ai_disconnect_cases.id>`
- `packetKind = "intervention_case"`
- `dealId = case.dealId` when present, otherwise `null`

This keeps:

- storage consistent
- review/feedback mechanics consistent
- provider fallback behavior consistent

### Packet Content for Intervention Case Copilot

The intervention packet should persist:

- `summaryText`
  - case brief
- `nextStepJson`
  - recommended next action
  - suggested owner
  - rationale
- `blindSpotsJson`
  - risk flags such as reopen risk or owner mismatch
- `evidenceJson`
  - concise evidence rows
- `confidence`

Required intervention-specific structured fields:

- `rootCause`
  - short root-cause hypothesis label + explanation
- `blockerOwner`
  - likely blocking owner or team context
- `reopenRisk`
  - normalized low/medium/high risk label + rationale

These fields may live inside `blindSpotsJson` or `nextStepJson`, but the server response contract must normalize them into explicit top-level copilot view fields so the client does not depend on ad hoc packet JSON keys.

### Similar Cases

Similar-case rows should be computed live from intervention history/current case data and returned in the copilot view payload.

Do **not** try to persist similar-case matches inside the packet for v1. They are cheap enough to compute server-side and easier to keep fresh if they remain derived.

## Similar-Case Logic

V1 should stay deterministic and legible.

Base similarity on:

- same `disconnectType`
- same `clusterKey` when present
- same `severity` bucket as a tie-break signal
- same `stageKey` from case metadata as a secondary tie-break signal when available

Guardrails:

- retrieval is scoped to the current tenant office only
- the current case id must be excluded from the result set
- only concluded historical intervention cases from the same office are eligible

Deterministic ranking for v1:

1. same `disconnectType` is required
2. same `clusterKey` ranks above cases with only disconnect-type match
3. same `severity` ranks above non-matching severity
4. same `stageKey` ranks above non-matching stage when present
5. more recent conclusions rank above older conclusions

Each similar-case result should include:

- case id
- business key
- disconnect type
- cluster key
- assignee at conclusion if known
- final conclusion kind
- conclusion reason code
- durable close flag
- reopen flag
- days to durable closure if available
- deep link into `/admin/interventions?caseId=<id>` when still addressable

Limit:

- top 5 similar cases

Sort:

- best match first
- then most recent conclusions

## Recommendation Logic

V1 should combine deterministic context + packet generation rather than rely on a black-box model alone.

The copilot input should include:

- current case status
- severity
- age
- current assignee id/name
- current owner/team context from the case and generated task, when present
- escalated flag
- snoozed-until / breach state
- reopen count
- structured history
- generated-task state
- deal/company/stage metadata when present
- similar-case outcome summaries

The provider prompt should produce:

- summary
- recommended next action
- blind spots
- confidence
- evidence

Recommended next action must be constrained to the existing intervention action vocabulary:

- `assign`
- `resolve`
- `snooze`
- `escalate`
- `investigate`

`investigate` is advisory only and means “do not mutate yet; inspect evidence/task/deal context first.”

## Fallback Behavior

### No External Model Keys

If no external model provider is configured, the intervention copilot must still work using the existing heuristic provider path.

### Packet Generation Failure

If packet generation fails:

- the detail sheet still opens normally
- the copilot section renders a localized error state
- direct action controls remain usable
- no page-wide failure is allowed

### No Historical Matches

If no similar cases exist:

- show an explicit empty state in `Similar Historical Cases`
- do not suppress the rest of the copilot

## Routes and API

Add intervention-scoped endpoints under the existing AI routes:

- `GET /api/ai/ops/interventions/:id/copilot`
  - returns the current copilot view for one intervention case
- `POST /api/ai/ops/interventions/:id/copilot/regenerate`
  - queues or regenerates a fresh packet for that intervention case

Authorization:

- these endpoints require the same intervention-workspace access level as the existing intervention detail route
- only `admin` and `director` may access them
- requests must be office/case scoped through the same active-office rules used by the intervention workspace

V1 may generate synchronously or via the existing job queue, but the user-facing contract should match deal copilot behavior:

- current packet is shown immediately if one exists
- regenerate is explicit
- refresh state is visible

GET semantics:

- if a ready packet exists, `GET` returns that packet plus current derived similar-case rows
- if regeneration is pending, `GET` still returns the latest ready packet and marks the view as refresh-pending
- if no packet exists yet, `GET` returns an empty packet state plus derived similar-case rows when possible

Client-visible freshness fields:

- `isRefreshPending`
- `isStale`
- `latestCaseChangedAt`
- `packetGeneratedAt`

Freshness / invalidation rules:

- any successful intervention mutation on that case (`assign`, `snooze`, `resolve`, `escalate`) marks the current packet stale
- any backend state change that materially changes copilot inputs also marks the packet stale
  - reopen/materialization
  - generated-task linkage/status changes
  - assignee changes
- stale packets may still render until regenerated, but the UI must show that they predate the latest case change
- explicit regenerate clears the stale state once a newer packet is generated

## Client Contract

Add a new hook similar in spirit to `useDealCopilot`, but intervention-scoped:

- `useInterventionCopilot(caseId)`

The hook should expose:

- `data`
- `loading`
- `error`
- `regenerating`
- `refreshQueuedAt`
- `submittingFeedback`
- `refetch`
- `regenerate`
- `submitFeedback`

Queued refresh behavior:

- if regenerate is queued rather than synchronous, the hook polls `GET /api/ai/ops/interventions/:id/copilot` every 5 seconds while `refreshQueuedAt` is set
- polling stops once `packetGeneratedAt >= refreshQueuedAt`
- polling also stops if the request errors, in which case the localized copilot error state is shown

The returned view should include:

- `packet`
- `riskFlags`
- `similarCases`
- `recommendedAction`
- `rootCause`
- `blockerOwner`
- `reopenRisk`
- `currentAssignee`
- `isRefreshPending`
- `isStale`
- `latestCaseChangedAt`
- `packetGeneratedAt`

`recommendedAction` must be a normalized top-level object with at least:

- `action`
- `rationale`
- `suggestedOwner`
- `suggestedOwnerId`

Do not expose accepted/dismissed task-suggestion mutations in v1. This slice is judgment support, not AI task creation.

## Feedback

Add packet-level feedback buttons inside the copilot panel:

- `Useful`
- `Not useful`

Feedback should write through the existing `ai_feedback` path with a new feedback type:

- `intervention_case_copilot`

Feedback target:

- `targetType = "packet"`
- `targetId = <ai_copilot_packets.id>`

Idempotency rule:

- feedback remains append-only in storage, matching the existing feedback model
- the UI only allows one latest visible opinion per user per packet at a time
- if the same user changes opinion from `Useful` to `Not useful` or vice versa, the newer submission is treated as the active opinion for presentation/analytics in this slice

## Permissions

Only users already allowed to operate the intervention workspace should see the copilot:

- `admin`
- `director`

No role expansion in this slice.

## Success Criteria

This slice is successful if:

1. opening an intervention case shows a copilot advisory block in the existing detail sheet
2. the copilot provides a readable brief, next action, confidence, and evidence
3. similar historical cases render with durable-close / reopen context
4. users can regenerate the packet without leaving the detail sheet
5. failure in the copilot does not break the workspace or detail actions
6. no new top-level route or sidebar entry is introduced

## Verification

Must verify:

- new intervention copilot server view generation
- heuristic fallback path
- similar-case retrieval ordering and empty state
- packet feedback persistence
- detail sheet renders copilot state, loading state, and localized error state
- regenerate action works without breaking existing detail actions
- no sidebar or top-nav additions appear
