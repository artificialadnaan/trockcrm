# Lead Questionnaire V2 Design

## Goal

Make the lead detail page editable behind `ENABLE_LEAD_EDIT_V2`, add project-type-driven cascading questions, and enforce questionnaire completeness before a lead enters Sales Validation and again during conversion to Opportunity.

## Core Invariants

- Leads and deals are never hard-deleted.
- `isActive=false` means hidden by default, not nonexistent.
- Hidden records remain queryable by direct ID or explicit filter.
- Deals read lead questionnaire state through `sourceLeadId` lineage.

## Hidden Lead Behavior

- Hidden, non-converted leads remain readable but are read-only in the v2 surface.
- Hidden, converted leads remain readable through lineage and may accept answer-only edits.
- Conversion rejects hidden leads.
- The editable lead surface must not expose normal edit actions for hidden, non-converted leads.

## Two-Tier Gate Model

### Primary Gate

Server-enforced on transition into `sales_validation_stage`.

Requirements:
- existing qualification fields must be complete
- active questionnaire nodes for the selected project type must be complete
- child questions count only when their parent is visible under the parent/child reveal rules

### Backstop Gate

Server-enforced again during lead conversion.

Purpose:
- protect against stale clients
- protect direct API calls
- ensure a lead cannot convert with missing required questionnaire state even if the Sales Validation gate was bypassed earlier

## Question Model

Use additive tables, not JSON-on-lead-row state.

### `public.project_type_question_nodes`

Purpose:
- canonical questionnaire config
- baseline and project-type-specific prompts
- parent/child reveal structure

Columns:
- `id`
- `project_type_id NULL`
- `parent_node_id NULL`
- `parent_option_value NULL`
- `node_type`
- `key`
- `label`
- `prompt`
- `input_type`
- `options`
- `is_required`
- `display_order`
- `is_active`
- timestamps

Rules:
- no `visibility_rule` JSONB in v1
- reveal logic is limited to parent/child structure only
- a child is visible only when:
  - the parent is visible, and
  - the parent answer matches `parent_option_value`, or
  - when no `parent_option_value` is set, the parent answer is truthy

Correctness requirement:
- a hidden child never counts as missing
- if a parent is unanswered or false, a child like `xactimate` does not block Sales Validation entry

## Answer Storage

### `tenant.lead_question_answers`

Purpose:
- current answer state per `(lead_id, question_id)`

### `tenant.lead_question_answer_history`

Purpose:
- append-only audit trail keyed only by `lead_id`

Rules:
- original answer creation is the first history row
- updates append another history row
- `old_value_json = null` on first write
- deals never own a separate answer set

## Post-Conversion Edit Semantics

- Answers remain anchored to `lead_id`
- Deal-stage users edit those answers through lead lineage
- Answer edits update:
  - `lead_question_answers`
  - `lead_question_answer_history`
- Answer edits do **not** mutate core lead fields
- Answer edits do **not** tick `leads.updated_at`
- The lead row is logically frozen at conversion

## Legacy JSON Columns

Existing branch state includes:
- `leads.qualification_payload`
- `leads.project_type_question_payload`

V2 policy:
- table-backed questionnaire state is the only authoritative write path
- v2 code must never write to the legacy JSON columns
- read fallback is allowed only where needed to preserve flag-off behavior during rollout

Deprecation trigger:
- after **30 days of clean v2 operation post-rollout**, ship a follow-up migration that drops the legacy JSON columns
- no v3 lead-module work should begin until that cleanup migration is either shipped or explicitly waived

## Feature Flag

- `ENABLE_LEAD_EDIT_V2`
- default `false`
- flag-off behavior remains read-only and must not regress current production flows

## Delivery Boundaries

- additive schema only
- no Procore changes
- no HubSpot changes
- no hard delete behavior changes in this feature
- deal lineage remains the source of truth post-conversion
