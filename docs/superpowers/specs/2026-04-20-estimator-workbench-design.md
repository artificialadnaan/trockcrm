# Estimator Workbench Design

## Goal

Turn the current estimating shell inside the project estimating tab into an estimator-focused review workspace that supports document intake, extraction review, catalog-match review, pricing review, and promotion into the canonical estimate.

## Scope

This subproject only covers the interactive estimator workbench. It does not replace placeholder OCR extraction, add third-party market-rate providers, or redesign the estimate generation engine. Those remain follow-on subprojects.

## Product Shape

The workbench lives inside the existing estimating tab and sits above the current estimate editor. It is a split-pane layout:

- top summary strip with queue counts and readiness state
- left pane with the active workbench table
- right pane with evidence, reasoning, and row actions
- existing estimate model below as the canonical destination for promoted rows

The workbench sections are:

- `Documents`
- `Extractions`
- `Matches`
- `Pricing`
- `Review Log`

This is an estimator workbench, not a wizard. The UI should favor density, fast row selection, and minimal navigation overhead.

## Workflow

### Documents

The documents section shows uploaded source documents, OCR status, document type, and reprocess status. Estimators can:

- upload additional source documents
- requeue OCR for an existing document
- inspect document status

This section is operational, not analytical. It exists so the estimator can control the document feed into the rest of the pipeline.

### Extractions

The extractions section is the first substantive review table. Each row represents an extracted scope candidate. Estimators can:

- select a row
- edit key fields: normalized label, quantity, unit, division hint
- approve a usable extraction
- reject a bad extraction

Estimators do not create new extraction rows manually in this version. The goal is to make AI output reviewable and correctable without building a second data-entry product.

### Matches

The matches section shows the current catalog match suggestion for each extraction. Estimators can:

- review ranked candidate matches
- choose a different catalog match
- reject the suggested match

The right pane should show the selected extraction, the matched Procore catalog item, alternative candidates, and relevant historical evidence.

### Pricing

The pricing section shows pricing recommendations derived from catalog, historical estimates, and current logic. Estimators can:

- review recommended unit price and total
- approve a recommendation
- override the recommendation with an explicit value and reason
- reject a pricing suggestion

This is not a freeform pricing spreadsheet. The UI is structured around review and override of generated recommendations.

### Review Log

The review log is a chronological audit panel showing:

- approvals
- rejections
- remaps
- overrides
- promotions

Each entry includes the user, timestamp, subject type, and before/after context when available.

## Interaction Model

The workbench uses a split-pane layout because estimators need evidence visible while making decisions.

### Left Pane

The left pane contains the active table for the selected workbench section. Each table should support:

- row selection
- clear status badges
- sortable/scannable columns
- targeted inline edits where applicable

Dense tables are preferred over card layouts.

### Right Pane

The right pane is selection-driven.

When no row is selected, it shows summary guidance:

- counts by status
- what is ready for review
- what is blocked
- whether promotion is available

When a row is selected, it shows:

- source evidence
- current extracted values
- current match and alternatives
- historical comparables
- pricing rationale
- action controls for the current stage

This keeps the user in one place rather than forcing modal hopping or page changes.

## Backend/API Changes

The current read-only workflow routes are not sufficient for an interactive workbench. Add explicit mutation routes for estimator review actions.

## Workflow State Model

This workbench needs explicit status semantics so the UI, routes, and review log all agree on what each action means.

### Document states

Documents keep their existing OCR lifecycle:

- `queued`
- `processing`
- `completed`
- `failed`

Reprocess moves a document back to `queued` and creates a review event or operational event entry tied to the document.

### Extraction states

Extraction rows should support:

- `pending`
- `approved`
- `rejected`
- `unmatched`
- `processed`

Meaning:

- `pending` means awaiting estimator review or downstream generation
- `approved` means the estimator accepted the extraction as valid
- `rejected` means the estimator explicitly discarded it
- `unmatched` means generation could not produce a usable catalog match
- `processed` means the system used the extraction to create downstream records but it has not yet been estimator-approved

Editing an extraction does not itself imply approval. Approval is a separate action.

### Match states

Match rows should support:

- `suggested`
- `selected`
- `rejected`

Meaning:

- `suggested` means system-ranked but not estimator-confirmed
- `selected` means estimator-confirmed active match
- `rejected` means estimator discarded the match candidate

If an estimator remaps to another candidate, the chosen row becomes `selected` and the previously active suggestion is no longer treated as current.

### Pricing states

Pricing recommendations should support:

- `pending`
- `approved`
- `rejected`
- `overridden`

Meaning:

- `pending` means ready for pricing review
- `approved` means estimator accepted the recommendation as-is
- `rejected` means estimator discarded the recommendation
- `overridden` means estimator replaced the suggested value and supplied a reason

Promotion readiness should treat both `approved` and `overridden` pricing rows as eligible.

### Required route groups

- document actions
  - reprocess a document
- extraction actions
  - update extraction fields
  - approve extraction
  - reject extraction
- match actions
  - select a catalog match
  - reject a match
- pricing actions
  - approve pricing recommendation
  - override pricing recommendation
  - reject pricing recommendation

### Workflow state payload

The workflow-state route should return data shaped for the workbench instead of only raw record dumps. It should include:

- documents
- extraction rows
- match rows
- pricing rows
- review events
- summary counts by section/status
- promotion readiness indicators
- selected/current item markers for matches and pricing when applicable

The client should not have to reconstruct workflow status from unrelated arrays.

### Mutation response contract

Every mutation route should return enough data for the workbench to refresh deterministically. The minimum acceptable contract is:

- updated subject row
- any directly affected sibling rows when selection/current-state changes
- updated summary counts
- newly created review-event entry when one is written

The client may still choose to refetch the full workflow payload after mutation, but the API contract should be explicit enough to support either targeted updates or full refresh.

### Review-event logging

Every mutation must create a review-event record with:

- user attribution
- subject type and subject id
- event type
- before snapshot when relevant
- after snapshot when relevant
- reason when provided

This review log is part of the product, not just internal telemetry.

## Estimate Promotion

The workbench does not replace the canonical estimate model. Approved pricing recommendations still promote into the existing estimate sections and line items.

The workbench’s job is:

- review candidate data
- correct mismatches
- approve pricing
- send approved outputs into the estimate model

This preserves a single source of truth for the final estimate.

Promotion readiness is defined as:

- at least one pricing row in `approved` or `overridden`
- no required generation identifier missing for the selected batch
- no row-level validation errors on the records being promoted

The workbench may show unresolved rows elsewhere, but promotion must only operate on explicitly eligible pricing rows.

## Error Handling

The workbench should surface action failures inline and keep the selected context intact. Important cases:

- stale review state
- missing target rows
- invalid override inputs
- promotion attempted before approvals exist
- document reprocess failures

The user should never lose row context because an action failed.

## Testing

### Server

Add route and service coverage for:

- extraction update/approve/reject
- match select/reject
- pricing approve/override/reject
- document reprocess
- review-event logging
- promotion readiness rules

### Client

Add workbench interaction coverage for:

- section switching
- row selection
- evidence-pane rendering
- inline edit state
- action button enable/disable rules
- successful mutation refresh behavior

Tests should focus on workflow correctness and action behavior, not cosmetic rendering.

## Out of Scope

The following remain intentionally out of scope for this subproject:

- manual creation of brand-new extraction rows
- spreadsheet-style bulk editing
- replacement of placeholder OCR/parsing logic
- market-rate provider integrations
- major estimate-generation algorithm changes

Those are separate implementation slices after the workbench is usable.
