# T Rock CRM AI Copilot Design

**Date:** 2026-04-15
**Status:** Draft for review
**Scope:** Merge-safe AI layer for deal/account copilot, task generation, immediate next-step guidance, and admin blind-spot inference

## Goal

Add an AI layer on top of the CRM that helps sales and management answer:

- what is happening on this deal or account right now
- what should happen next
- which tasks should exist but do not
- where management has operational blind spots

The design must fit the CRM's existing normalized data model and must be safe to develop in parallel with other feature work. Phase 1 should be additive, read-heavy, and low-risk.

## Why not "RAG over the whole CRM"

The CRM already has a strong relational core:

- `company -> property -> lead -> deal`
- `contact`
- `activity`
- `task`
- `email_thread`
- `email_message`

For this kind of CRM, pure RAG is not the right system of record for workflow truth. Structured facts such as stage, owner, expected value, missing follow-up, revision status, due dates, and attachment completeness are better answered by deterministic queries.

RAG is useful for the text-heavy parts of the CRM:

- email bodies
- notes
- meeting summaries
- call logs
- estimate or proposal text
- OCR or extracted attachment text where available

The recommended architecture is therefore hybrid:

- relational queries for canonical facts
- vector retrieval for long-form text evidence
- an LLM on top of both for bounded inference

## Product Outcome

Phase 1 should produce four AI outputs:

### 1. Deal brief

A concise explanation of the current state of a deal:

- current stage and workflow context
- recent customer and team activity
- notable blockers or uncertainty
- why the deal matters now

### 2. Immediate next step

One recommended next action with:

- action description
- recommended owner
- recommended due window
- reason for recommendation
- evidence references

### 3. Task suggestions

Suggested tasks that are not currently present in the CRM:

- title
- description
- owner
- due date logic
- priority
- evidence references
- confidence

### 4. Admin blind spots

Operational gaps that management should see:

- stalled deals
- deals with no next task
- recent inbound customer communication with no follow-up
- revision loops with no clear owner movement
- estimating handoff gaps
- orphaned or owner-misaligned records
- accounts with activity patterns that suggest risk but low visibility

## Design Principles

### 1. Structured truth first

If an answer depends on canonical CRM state, the AI layer must use structured queries first and treat retrieval as supporting evidence.

### 2. Observe, infer, suggest, accept

Phase 1 is not autonomous workflow mutation. The AI layer:

- observes CRM state
- infers likely next actions or risk
- suggests tasks and actions
- waits for human acceptance before mutating canonical records

### 3. Additive and merge-safe

The AI layer must land as a bounded module with its own storage, services, and APIs rather than threading new logic through existing deal, email, or task code paths.

### 4. Evidence over vibes

Every AI-generated output must carry evidence references to:

- CRM entity IDs
- activity IDs
- email message IDs
- retrieved chunk IDs
- derived signal names where applicable

### 5. Deterministic checks stay deterministic

The LLM should not re-decide things the database already knows.

## Recommended Architecture

The AI system should have five layers.

### 1. Ground truth layer

The existing relational CRM remains the source of truth for:

- companies, properties, leads, deals
- ownership and associations
- stage and workflow state
- task state
- estimate and revision state
- activity records
- email metadata and links

### 2. Knowledge layer

Unstructured content is normalized into AI-searchable documents and chunks:

- email message body text
- notes
- call log notes
- meeting notes
- estimate text
- attachment text extraction where available

Each chunk should retain:

- source type
- source record ID
- account/deal/company links
- timestamps
- participants or owners when relevant

### 3. Signal layer

Deterministic SQL-derived signals should be computed before model reasoning. Examples:

- no outbound follow-up after recent inbound email
- no open task on active deal
- stage stale beyond threshold
- revision requested but no reassignment or task trail
- estimating handoff missing prerequisites
- recent negative customer sentiment markers in emails
- deal has activity but no explicit next meeting or task

Signals should be explicit machine-readable inputs, not hidden inside prompts.

### 4. Inference layer

An orchestration service assembles a bounded context packet:

- structured snapshot from SQL
- deterministic signals
- retrieved text evidence
- requested inference type

The model returns typed outputs such as:

- summary
- recommended next step
- task suggestions
- blind-spot flags
- confidence
- evidence list

### 5. Action and feedback layer

Users can:

- accept suggested tasks
- dismiss suggestions
- mark output as useful or not useful
- mark output as wrong
- request regeneration

This feedback is stored for tuning and prompt refinement later.

## Bounded Modules

To reduce merge conflicts with concurrent feature work, the AI layer should live in its own module.

Recommended backend boundary:

- `server/src/modules/ai-copilot/*`

Recommended jobs boundary:

- `worker/src/jobs/ai-*`

Recommended frontend boundary:

- new additive components mounted into existing deal and account screens

Avoid Phase 1 edits that deeply change:

- existing deal state transitions
- existing email categorization flows
- current task engine semantics
- current save/update handlers for primary CRM entities

## Data Model Additions

Phase 1 should prefer new tables over invasive changes to core CRM tables.

### `ai_document_index`

Tracks source documents available for AI processing.

Suggested fields:

- `id`
- `source_type` such as `email_message`, `note`, `estimate`, `attachment_text`
- `source_id`
- `company_id`
- `property_id`
- `lead_id`
- `deal_id`
- `created_at`
- `updated_at`
- `indexed_at`
- `index_status`
- `content_hash`
- `metadata_json`

### `ai_embedding_chunk`

Stores chunked text plus embedding vector.

Suggested fields:

- `id`
- `document_id`
- `chunk_index`
- `text`
- `embedding`
- `token_count`
- `created_at`
- `metadata_json`

This can use `pgvector` in Postgres for Phase 1 to keep the system operationally simple.

### `ai_copilot_packet`

Stores generated AI output for a record snapshot.

Suggested fields:

- `id`
- `scope_type` such as `deal` or `company`
- `scope_id`
- `packet_kind` such as `deal_brief`, `account_brief`, `next_step`
- `snapshot_hash`
- `model_name`
- `status`
- `summary_text`
- `next_step_json`
- `blind_spots_json`
- `confidence`
- `evidence_json`
- `generated_at`
- `expires_at`

### `ai_task_suggestion`

Stores task recommendations before acceptance.

Suggested fields:

- `id`
- `packet_id`
- `scope_type`
- `scope_id`
- `title`
- `description`
- `suggested_owner_id`
- `suggested_due_at`
- `priority`
- `confidence`
- `evidence_json`
- `status` such as `suggested`, `accepted`, `dismissed`
- `accepted_task_id` nullable
- `created_at`
- `resolved_at`

### `ai_risk_flag`

Stores machine-readable risk or blind-spot findings.

Suggested fields:

- `id`
- `scope_type`
- `scope_id`
- `flag_type`
- `severity`
- `status`
- `title`
- `details`
- `evidence_json`
- `created_at`
- `resolved_at`

### `ai_feedback`

Stores user quality signals.

Suggested fields:

- `id`
- `target_type`
- `target_id`
- `user_id`
- `feedback_type`
- `feedback_value`
- `comment`
- `created_at`

## Retrieval Scope

### Include in vector retrieval

- email body text
- note text
- meeting summary text
- call log notes
- estimate or proposal text
- extracted attachment text where it materially improves context

### Do not use vector retrieval as source of truth for

- current stage
- owner
- task state
- due dates
- amount
- canonical associations
- required workflow prerequisites

Those belong to relational queries and derived signals.

## Inference Contract

The AI orchestration layer should not pass the entire CRM record blob to the model. It should expose bounded tools or service calls such as:

- `getDealSnapshot(dealId)`
- `getAccountSnapshot(companyId)`
- `getRecentActivity(scopeType, scopeId, windowDays)`
- `getOpenTasks(scopeType, scopeId)`
- `getDeterministicSignals(scopeType, scopeId)`
- `searchKnowledge(scopeType, scopeId, query)`
- `getEmailThread(threadId)`

The model should operate with strict JSON-shaped outputs. Example top-level contracts:

- `dealBrief`
- `recommendedNextStep`
- `suggestedTasks[]`
- `blindSpotFlags[]`

Each response should include:

- `confidence`
- `reasoning_summary`
- `evidence[]`

The public-facing UX may display a friendly narrative, but the storage and API layer should keep typed fields.

## Deterministic vs AI Responsibilities

### Deterministic responsibilities

- stale deal detection
- no activity in threshold window
- no next task on active deal
- inbound email with no response in threshold window
- missing estimate or revision follow-up
- missing attachment or handoff requirement
- orphaned owner or broken association patterns

### AI responsibilities

- summarize customer context from long communication history
- infer likely blocker from email or note language
- rank which issue matters most right now
- propose the best next action
- draft suggested task titles and descriptions
- identify patterns across multiple communications that deserve management attention

## API Shape

Phase 1 should introduce additive APIs only.

Suggested endpoints:

- `GET /api/ai/deals/:id/copilot`
- `POST /api/ai/deals/:id/regenerate`
- `GET /api/ai/companies/:id/copilot`
- `POST /api/ai/task-suggestions/:id/accept`
- `POST /api/ai/task-suggestions/:id/dismiss`
- `POST /api/ai/feedback`

These endpoints should not require changes to existing deal or task APIs beyond accepted task creation integration.

## UI Shape

Phase 1 should mount AI as additive panels rather than reworking the current CRM screens.

### Deal page

Add a `DealCopilotPanel` that shows:

- AI brief
- immediate next step
- suggested tasks
- risk flags
- evidence links

### Account page

Add an `AccountCopilotPanel` that shows:

- account summary
- cross-deal or cross-contact issues
- admin blind spots
- suggested management follow-ups

### Admin or manager surfaces

Add blind-spot cards or queue views for:

- unowned or stalled records
- risky deals with no next action
- follow-up failures after inbound communication
- revision loops or handoff breakdowns

## Background Jobs

Phase 1 should use background jobs for indexing and packet generation.

Suggested jobs:

- `ai-index-document`
- `ai-reindex-scope`
- `ai-generate-deal-copilot`
- `ai-generate-account-copilot`
- `ai-refresh-stale-packets`

Generation should be event-triggered and also refresh on demand. Triggers may include:

- new email synced
- note or activity created
- task created or completed
- stage changed
- estimate or revision state changed

The job layer should debounce frequent changes so packet generation does not thrash.

## Model Vendor Strategy

The architecture should stay vendor-neutral. Both Codex API and Claude API can fit if the orchestration contract is stable.

Required model capabilities:

- function or tool calling
- structured JSON output
- strong instruction following
- good long-context reasoning on mixed structured and retrieved text

The vendor integration should be isolated behind one provider interface so the CRM can:

- change models
- run side-by-side evaluation
- compare quality
- control cost per inference type

## Safety and Trust

Phase 1 outputs must be advisory, not authoritative.

Requirements:

- AI cannot directly move stages
- AI cannot directly close or reopen records
- AI cannot silently create canonical tasks except in future explicitly approved deterministic automations
- every AI recommendation should surface evidence
- low-confidence outputs should be labeled or suppressed

## Merge-Safe Delivery Strategy

Because another Codex instance is landing unrelated feature work, the AI implementation should minimize overlap by following these constraints:

- new tables only for AI artifacts
- new module boundaries only for AI services
- additive routes only for AI endpoints
- additive UI panels only for AI surfaces
- read-only integration into existing CRM models wherever possible
- task creation integration limited to a single accept-suggestion seam

If existing files must be touched, prefer extension seams over rewrites and keep the touch count low.

## Phase Plan

### Phase 1A: Deal copilot foundation

- document indexing for emails and notes
- deterministic risk signal computation
- deal-level copilot packet generation
- deal page AI panel

### Phase 1B: Suggested tasks and immediate next steps

- task suggestion generation
- accept or dismiss flows
- user feedback capture

### Phase 1C: Admin blind spots

- manager-facing risk and blind-spot flags
- account-level aggregation where needed

### Phase 2

- richer account-level copilot
- natural-language CRM search
- forecast or close-probability assistance
- draft email generation
- limited high-confidence automations

## Success Criteria

Phase 1 is successful when:

- reps can open a deal and immediately see a useful AI brief
- the system recommends a next action that is usually better than starting from a blank page
- suggested tasks help fill follow-up gaps without creating noise
- managers can identify neglected or risky deals faster than with current manual review
- AI outputs consistently cite evidence and remain aligned with structured CRM truth
- the implementation merges cleanly alongside ongoing feature work with minimal conflicts

## Open Decisions for the implementation plan

These should be resolved during planning, not left ambiguous during coding:

- exact chunking and embedding strategy for emails and notes
- cache invalidation rules for copilot packets
- threshold definitions for deterministic blind-spot signals
- whether account-level copilot ships in the first implementation slice or immediately after deal-level validation
- provider selection and evaluation framework for Codex API vs Claude API

## Recommendation

Build a hybrid, merge-safe AI copilot on top of the CRM with this rule:

structured SQL is the truth, retrieval provides evidence, and the model produces bounded suggestions rather than autonomous mutations.

That gives the CRM the right foundation for:

- account and deal copilot
- next-step guidance
- task generation
- admin blind-spot detection

without turning the CRM into an opaque chatbot or creating merge-heavy risk in the existing codebase.
