# Intervention Outcome Capture and Resolution Effectiveness Design

## Goal

Extend the admin-first intervention system so every conclusion action produces structured, reliable outcome data.

This slice should answer:

- what conclusion was made on an intervention case
- why that conclusion was chosen
- who made it
- whether that conclusion actually held or quickly reopened
- which conclusion patterns appear effective versus cosmetic

This phase is not about generating more AI actions. It is about making the current intervention system measurable and trustworthy.

---

## Existing Context

The current intervention stack already provides:

- `/admin/sales-process-disconnects`
  - read-first process diagnostics
- `/admin/interventions`
  - writable case-management surface
- `/admin/intervention-analytics`
  - SLA, hotspots, and manager oversight
- manager alerts + SLA escalations
  - preview, send, and scheduled summary loop

Current intervention state is split across:

- `ai_disconnect_cases`
  - latest case status and assignment state
- `ai_disconnect_case_history`
  - action trail with:
    - `actionType`
    - actor
    - status transition
    - assignee transition
    - snooze transition
    - `notes`
    - `metadataJson`

The current gap is that conclusion actions change case state, but they do not yet require structured explanation of what was decided and why.

That weakens:

- manager learning
- reopen analysis
- conclusion quality analytics
- future deterministic task/priority tuning

---

## Problem

Today, an intervention can be:

- resolved
- snoozed
- escalated

But the system does not yet enforce structured outcome capture at those decision points.

That creates four problems:

1. conclusions are hard to compare
- freeform notes are inconsistent
- silent state changes are analytically weak

2. reopens are hard to interpret
- a reopened case tells us something failed
- but not what conclusion was previously attempted

3. manager analytics are incomplete
- we can see queue movement
- but not whether movement represented a real fix

4. future automation quality is capped
- without structured conclusion data, the system cannot learn which intervention patterns are actually effective

---

## Recommended Approach

Use `ai_disconnect_case_history` as the canonical outcome store and require structured conclusion metadata on every case conclusion action.

V1 should:

- hard-block `resolve`, `snooze`, and `escalate` until required structured fields are filled
- store the structured conclusion data inside `ai_disconnect_case_history.metadataJson`
- keep `ai_disconnect_cases` as the latest-state row only
- derive effectiveness analytics from:
  - conclusion history events
  - later reopen behavior
  - current case state

This slice should not:

- introduce a separate `intervention_outcomes` table in v1
- allow “fill this in later” conclusion data
- add AI-written freeform narratives as the primary outcome model

---

## Alternatives Considered

### 1. Dedicated `intervention_outcomes` table

Pros:

- clean separation of outcome records
- easier to expand if outcomes later become their own workflow

Cons:

- duplicates the existing history system
- introduces more joins and sync risk
- not justified for v1

### 2. Optional structured fields plus freeform notes

Pros:

- lower user friction
- easy to roll out

Cons:

- data quality degrades immediately
- weakens effectiveness analytics
- encourages “move first, explain later”

### 3. Recommended: required structured history metadata on conclusion events

Pros:

- one canonical audit trail
- lowest schema risk
- strongest immediate analytics value
- aligns to the current intervention event model

Cons:

- adds friction to conclusion actions
- requires careful UI/forms design to stay usable

---

## Core Design

### Canonical storage model

`ai_disconnect_case_history` remains the single source of truth for intervention action events.

For v1:

- `resolved`, `snoozed`, and `escalated` history events must include structured outcome metadata in `metadataJson`
- `assigned` and other non-conclusion events do not require this payload
- `notes` remains optional supporting text, not the canonical outcome structure

This preserves:

- one event stream
- one case-history query path
- one audit model for “what changed and why”

### Conclusion actions covered in scope

V1 conclusion actions:

- `resolve`
- `snooze`
- `escalate`

Each conclusion action must be blocked until the required structured fields are provided.

No deferred completion flow.

### Required conclusion payloads

#### 1. Resolve

Required fields:

- `outcomeCategory`
  - one of:
    - `issue_fixed`
    - `owner_aligned`
    - `task_completed`
    - `duplicate_or_merged`
    - `false_positive`
    - `no_longer_relevant`
- `resolutionReasonCode`
  - deterministic subreason aligned to the chosen category
  - allowed values in v1:
    - `customer_replied_and_owner_followed_up`
    - `work_advanced_after_follow_up`
    - `missing_task_created_and_completed`
    - `owner_assigned_and_confirmed`
    - `duplicate_case_consolidated`
    - `signal_was_not_actionable`
    - `business_context_changed`
- `effectivenessExpectation`
  - one of:
    - `high_confidence`
    - `partial_fix`
    - `administrative_close`

Optional:

- `notes`

Valid combination rule:

- `resolutionReasonCode` must belong to the selected `outcomeCategory`

Recommended v1 mapping:

- `issue_fixed`
  - `customer_replied_and_owner_followed_up`
  - `work_advanced_after_follow_up`
- `owner_aligned`
  - `owner_assigned_and_confirmed`
- `task_completed`
  - `missing_task_created_and_completed`
- `duplicate_or_merged`
  - `duplicate_case_consolidated`
- `false_positive`
  - `signal_was_not_actionable`
- `no_longer_relevant`
  - `business_context_changed`

#### 2. Snooze

Required fields:

- `snoozeReasonCode`
  - one of:
    - `waiting_on_customer`
    - `waiting_on_rep`
    - `waiting_on_estimating`
    - `waiting_on_manager_review`
    - `waiting_on_external`
    - `timing_not_actionable_yet`
    - `temporary_false_positive`
- `snoozedUntil`
  - already required by current workflow and remains required
- `expectedOwnerType`
  - one of:
    - `rep`
    - `admin`
    - `director`
    - `customer`
    - `estimating`
    - `external`
- `expectedNextStepCode`
  - deterministic next-step label
  - allowed values in v1:
    - `customer_reply_expected`
    - `rep_follow_up_expected`
    - `estimating_update_expected`
    - `manager_review_expected`
    - `external_dependency_expected`
    - `timing_window_reached`

Optional:

- `notes`

Valid combination rule:

- `expectedNextStepCode` must be compatible with `snoozeReasonCode`
- `expectedOwnerType` must be compatible with the chosen next step

Recommended v1 combinations:

- `waiting_on_customer`
  - owner: `customer`
  - next step:
    - `customer_reply_expected`
- `waiting_on_rep`
  - owner: `rep`
  - next step:
    - `rep_follow_up_expected`
- `waiting_on_estimating`
  - owner: `estimating`
  - next step:
    - `estimating_update_expected`
- `waiting_on_manager_review`
  - owner: `director`
  - next step:
    - `manager_review_expected`
- `timing_not_actionable_yet`
  - owner:
    - `admin`
    - `director`
  - next step:
    - `timing_window_reached`
- `waiting_on_external`
  - owner: `external`
  - next step:
    - `external_dependency_expected`
- `temporary_false_positive`
  - owner:
    - `admin`
    - `director`
  - next step:
    - `manager_review_expected`

#### 3. Escalate

Required fields:

- `escalationReasonCode`
  - one of:
    - `rep_non_response`
    - `estimating_block`
    - `customer_risk`
    - `manager_decision_needed`
    - `cross_team_blocker`
    - `repeat_failure_pattern`
- `escalationTargetType`
  - one of:
    - `director`
    - `admin`
    - `estimating_lead`
    - `office_manager`
    - `other`
- `urgencyLevel`
  - one of:
    - `same_day`
    - `this_week`
    - `monitor_only`

Optional:

- `notes`

Special validation rule:

- if `escalationTargetType = other`, the payload must also include `escalationTargetLabel`
- for all other target types, `escalationTargetLabel` is optional and informational only

### Metadata shape

Recommended event metadata structure:

```json
{
  "conclusion": {
    "kind": "resolve",
    "outcomeCategory": "issue_fixed",
    "resolutionReasonCode": "customer_replied_and_owner_followed_up",
    "effectivenessExpectation": "high_confidence"
  }
}
```

Equivalent event-local structures should be used for `snooze` and `escalate`.

Implementation rule:

- the top-level metadata object may continue carrying other existing event metadata
- conclusion payload must live in a dedicated `conclusion` object so analytics parsing stays deterministic

### Escalation lifecycle semantics

Escalation is a conclusion action for the current decision point, but it is not terminal in the same way resolution is.

V1 should treat escalation as attempt-based in history:

- every `escalate` action records a distinct escalation attempt in `ai_disconnect_case_history`
- the current case row may still keep a simple latest-state `escalated` flag for queue behavior
- analytics must count escalation effectiveness from history attempts, not from the current boolean alone

Reset rule:

- a new `resolve` event clears the active escalation condition
- a new `snooze` event clears the active escalation condition for queue purposes
- a reopened lifecycle may be escalated again and must create a new escalation-attempt history event

Latest-state flag rule:

- `ai_disconnect_cases.escalated = true` after an escalate action on the active lifecycle
- `ai_disconnect_cases.escalated = false` after a resolve action
- `ai_disconnect_cases.escalated = false` after a snooze action
- `ai_disconnect_cases.escalated = false` when a new lifecycle is reopened unless that lifecycle is escalated again

Important implementation rule:

- repeat escalations must not be invisible just because `ai_disconnect_cases.escalated` was already true earlier in the case’s lifetime
- if the latest active lifecycle is escalated again, history must record that new attempt explicitly

---

## UI / Workflow Changes

### `/admin/interventions`

Conclusion actions in both surfaces must collect structured payloads:

- batch toolbar
- detail panel

Behavior:

- `Resolve selected` opens a structured resolve form
- `Snooze selected` opens a structured snooze form
- `Escalate selected` opens a structured escalate form
- submit remains disabled until required fields are complete

For single-case detail actions:

- existing detail-sheet actions must also require the same structured fields
- batch and detail forms must share the same field definitions and validation rules

### Operator experience

The UI should stay concise.

V1 should prefer:

- short selects
- deterministic radio/button groups where possible
- one optional notes field

It should not become a large case-closing questionnaire.

### No silent fallback

The UI must not:

- auto-fill hidden defaults just to bypass required outcome capture
- allow submit with only freeform notes
- silently map unknown values into catch-all strings

If a required structured field is not set, the action should not execute.

### Rollout and compatibility

This slice tightens existing intervention mutation contracts, so rollout must not assume all callers update at once.

Recommended v1 rollout:

- server accepts both:
  - existing flat mutation shape
  - new structured conclusion payload
- updated UI writes both during transition:
  - current flat fields where still required by existing server logic
  - canonical structured `conclusion` payload in history metadata
- server must not invent canonical structured values from legacy flat fields
- once the updated workspace is deployed and verified, server validation can require the structured payload for all supported clients

Compatibility rule:

- old history rows remain valid legacy events
- old clients should not hard-fail during the first mixed deploy window
- the implementation plan should include an explicit transition step, not a same-commit contract break

Compatibility gate:

- gate legacy-only conclusion writes behind one explicit server flag:
  - `allowLegacyOutcomeWrites`
- if a request arrives with only legacy flat fields and no structured conclusion payload, the server should allow it only during the explicit transition window
- those requests must be persisted as legacy conclusion events, not fake canonical structured events
- effectiveness analytics must ignore legacy-only conclusion rows for structured outcome metrics
- once `allowLegacyOutcomeWrites = false`, the server should reject legacy-only conclusion writes with `400`

Consistency rule during transition:

- if a request includes both:
  - legacy flat conclusion fields
  - structured `conclusion` payload
- the server must treat the structured payload as canonical
- any derived legacy compatibility fields must be generated from the structured payload
- if caller-supplied legacy flat values conflict with the structured payload, the request should fail with `400`

Legacy-write mapping rule:

- when the updated client sends the new structured resolve payload during transition, the server may still populate the legacy flat `resolutionReason` field for backward compatibility
- that mapping must be deterministic and one-way

Recommended v1 resolve mapping:

- `customer_replied_and_owner_followed_up` -> legacy `follow_up_completed`
- `work_advanced_after_follow_up` -> legacy `follow_up_completed`
- `owner_assigned_and_confirmed` -> legacy `owner_aligned`
- `missing_task_created_and_completed` -> legacy `task_completed`
- `duplicate_case_consolidated` -> legacy `duplicate_case`
- `signal_was_not_actionable` -> legacy `false_positive`
- `business_context_changed` -> legacy `issue_no_longer_relevant`

Recommended rollout cutoff:

- enable `allowLegacyOutcomeWrites = true` only for the first mixed deploy
- once the updated intervention workspace is deployed to production and verified, flip the flag to `false`
- do not leave the flag permanently enabled

---

## Analytics / Effectiveness Layer

This slice should add manager-learning metrics, not just raw event counts.

Primary questions:

- which resolution categories reopen most often
- which snooze reasons routinely come back unresolved
- which escalation reasons actually lead to later closure
- which conclusion patterns appear effective by disconnect type

V1 effectiveness outputs should include:

- reopen rate by resolution category
- reopen rate by snooze reason
- reopen rate by escalation reason
- conclusion mix by disconnect type
- conclusion mix by acting user
- conclusion mix by assignee at time of conclusion
- median days to reopen after each conclusion family

Important rule:

- effectiveness is measured from history events plus later reopen state
- not from current row labels alone

Reopen precision rule:

- this slice must persist an explicit reopen history event whenever a case lifecycle reopens
- that reopen event must include the exact reopen timestamp in history
- reopen attribution and “days to reopen” metrics must be computed from:
  - prior conclusion event timestamp
  - next reopen event timestamp

`reopenCount` remains useful as latest-state summary, but it is not precise enough to serve as the canonical reopen analytics source by itself.

Reopen event definition:

- new history `actionType`: `reopened`
- required reopen event metadata:
  - `priorConclusionKind`
  - `priorConclusionActionId`
  - `reopenReason`

Allowed `reopenReason` values in v1:

- `signal_still_present`
- `snooze_expired_without_progress`
- `escalation_did_not_move_issue`
- `resolution_did_not_hold`
- `new_evidence_reopened_case`

Reopen writer rule:

- when case materialization logic changes a previously concluded lifecycle back into an active lifecycle, it must write a `reopened` history event in the same transactional flow that increments `reopenCount` and resets lifecycle state
- the writer for this event should live in the same intervention/materialization path that currently decides whether a case reopens
- because `ai_disconnect_case_history.actedBy` is non-null, automatic reopen events must use the system actor convention already used for non-human automation writes in this codebase
- if no reusable system actor convention exists yet, implementation must add one explicit system-user id before this event type ships

Reopen idempotency rule:

- one reopen transition for one lifecycle reset may produce only one `reopened` history event
- retries or repeated materialization passes must not emit duplicate reopen events for the same transition
- recommended dedupe key:
  - `disconnectCaseId`
  - `priorConclusionActionId`
  - `actionType = reopened`

That keeps analytics tied to what actually happened, not what the case currently says.

---

## Reopen Semantics

Outcome effectiveness must treat reopen as the primary signal that a previous conclusion did not hold.

Recommended rule set:

- if a case is concluded and later reopens, the prior conclusion counts as a reopen-linked outcome
- analytics should attribute the reopen to the latest prior conclusion event
- if a case is concluded multiple times, each conclusion stands as its own effectiveness attempt

Canonical implementation rule:

- reopen attribution must use the next explicit reopen history event after a conclusion event
- if no reopen history event exists after that conclusion, the conclusion remains non-reopened for measured analytics

Conclusion family taxonomy for v1:

- `resolve`
- `snooze`
- `escalate`

Analytics grouping definitions:

- `conclusion mix by acting user`
  - group by `ai_disconnect_case_history.actedBy`
- `conclusion mix by assignee at time of conclusion`
  - group by the effective assignee captured on the conclusion event
- `median days to reopen after each conclusion family`
  - group by conclusion `kind`
  - use only rows with a later linked `reopened` event

This means conclusion effectiveness is lifecycle-based, not case-based.

That is important because one case can cycle through:

- snooze
- reopen
- escalate
- resolve
- reopen again

Each step should remain analytically distinct.

---

## API and Contract Impact

The existing intervention mutation routes should stay the same at the route level, but their payload contracts must tighten.

Affected actions:

- batch resolve
- batch snooze
- batch escalate
- single-case resolve
- single-case snooze
- single-case escalate

Contract rule:

- each request must include the structured conclusion payload required for that action
- server validation must reject incomplete payloads with `400`

Transition rule:

- during rollout, the server may temporarily accept legacy flat fields from older callers
- canonical persistence for new events must write the structured conclusion payload only when that payload is explicitly provided by the updated client
- after the UI transition is complete, the contract may be tightened to hard-require structured payloads

The response contract should continue to return structured update/skip/error outcomes.

Batch validation rule:

- invalid batch cohort composition is a request-level validation failure and should return `400`
- once a batch passes cohort validation, per-case execution may still produce:
  - `updated`
  - `skipped`
  - `error`

No new standalone outcome route is required in v1.

---

## History and Feedback Writes

Current intervention actions already dual-write into:

- `ai_disconnect_case_history`
- `ai_feedback`

V1 should preserve that pattern.

Recommended rule:

- structured conclusion payload is canonical in history metadata
- any matching `ai_feedback` write should remain secondary and must not become the source of truth

If a conclusion action writes both:

- the history write is required
- the feedback write remains supplemental

---

## Data Quality Rules

To keep the data usable:

- required structured fields must be enum-like code values, not freeform text
- optional notes may be freeform
- unknown or deprecated codes must fail validation, not silently coerce
- batch actions must apply the exact same structured conclusion payload to every affected case in that batch

Batch constraint:

- v1 intentionally does not support per-row custom payloads inside one batch action
- therefore batch conclusion actions must be limited to homogeneous selections where one payload is semantically valid for every selected case
- if the selected cases do not share the required conclusion cohort, the batch action should be blocked with a clear validation message

Recommended homogeneous cohorts for v1:

- same action type
- same disconnect type
- same target reason family where the chosen conclusion payload depends on it

Failure semantics:

- heterogeneous batch cohort -> reject the whole request with `400`
- homogeneous batch with normal per-row execution differences -> preserve structured update/skip/error outcomes

That keeps batch behavior predictable.

---

## Migration / Backfill

V1 should not backfill fake conclusion payloads for old history rows.

Recommended treatment:

- historical rows without conclusion metadata remain valid legacy events
- effectiveness analytics should ignore rows that do not contain the required `conclusion` payload
- reporting should use “structured outcome coverage” language when helpful

This avoids inventing historical meaning that never existed.

---

## Success Criteria

The slice is successful when:

- no `resolve`, `snooze`, or `escalate` action can occur without structured conclusion data
- every new conclusion event writes a parseable `conclusion` payload into `ai_disconnect_case_history.metadataJson`
- batch and detail actions use the same validation rules
- effectiveness analytics can answer which conclusion families reopen most often
- managers can distinguish “real closure” from “queue movement”

---

## Out of Scope

Not in v1:

- a dedicated `intervention_outcomes` table
- rep-facing outcome prompts
- AI-generated outcome narratives
- per-row custom payloads in a single batch submit
- recent outcome coaching or recommendations
- retrospective manual editing of past conclusion payloads

---

## Recommendation

Build `Intervention Outcome Capture and Resolution Effectiveness` as a history-first extension of the current intervention system.

Keep:

- `ai_disconnect_cases` for latest state
- `ai_disconnect_case_history` for canonical conclusion evidence

Require structured outcome payloads at every conclusion action:

- `resolve`
- `snooze`
- `escalate`

Then use those history events to power effectiveness analytics for managers.

This produces the highest immediate value because it closes the biggest remaining gap:

- not just what changed
- but whether the intervention decision actually worked
