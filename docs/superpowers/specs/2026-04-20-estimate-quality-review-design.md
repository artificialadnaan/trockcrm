# Estimate Quality Review Design

## Goal

Improve draft-estimate quality inside the existing estimating workbench by making generated rows more reviewable, more complete, and easier to correct. This slice focuses on three quality failures at once:

- wrong scope mapping
- wrong price
- missing line items

The target outcome is not autonomous bidding. The target outcome is a better line-by-line estimator review flow where the system proposes stronger defaults, shows ranked alternates, surfaces inferred missing scope, and captures estimator decisions as structured feedback.

## Product Shape

This remains inside the project estimating tab and extends the current estimator workbench. The review model stays line-by-line.

Each generated row should support:

- one recommended line item shown as the default
- two to four ranked alternates
- evidence explaining why the default and alternates were proposed
- explicit distinction between `extracted` rows and `inferred` rows
- line-level actions:
  - accept recommended
  - switch to alternate
  - override price
  - reject
  - add missing item

Missing inferred rows are review-required by default and must never auto-promote into pricing without estimator action.

## Recommended Approach

### Approach 1: Review-Centric Estimate Quality

Improve generation quality and review clarity together. Each row gets a recommended option, ranked alternates, missing-scope suggestions, and stronger evidence. Estimators can add missing rows manually and optionally promote custom rows into the local catalog immediately.

Tradeoff:
- strongest demo value
- best match for current workflow
- builds directly on the parsing and workbench slices already implemented

### Approach 2: Pricing-First Upgrade

Focus mainly on better unit-price recommendations, override reasons, and historical evidence, while leaving scope mapping and omission detection thinner.

Tradeoff:
- easier to ship
- weaker at solving wrong mapping and missing rows

### Approach 3: Coverage-First Omission Engine

Focus on inferred missing scope and companion-item detection before improving ranking and line review UX.

Tradeoff:
- strong omission-detection story
- weaker estimator review experience

### Recommendation

Use Approach 1. It produces the most believable estimator-facing quality improvement without introducing a new product surface.

## Workflow

The workbench should evolve from “review the generated row” to “review a recommendation set.”

For each line candidate:

1. the system proposes a recommended catalog-backed line item
2. the system proposes ranked alternates
3. the system shows pricing rationale for the recommended option and for alternates
4. the estimator chooses one of the following:
   - accept as-is
   - select alternate
   - override quantity/unit/price
   - reject
   - add a missing row manually

For inferred missing items:

1. the system marks them as `inferred`
2. the system shows omission rationale and evidence
3. the estimator can accept, reject, or replace them with a manual/custom row

## Review Signals

This slice should treat estimator actions as training signals rather than simple state changes.

Capture at minimum:

- accepted recommended option
- switched to alternate option
- overrode price
- overrode quantity or unit
- rejected generated row
- added missing row manually
- promoted custom row to local catalog

These events should remain tied to the deal, source row, recommended option, chosen option, and final estimate outcome where possible.

## Data Model Direction

This slice should not replace the current estimate generation tables. It should extend them to support ranked choices and manual additions.

Source of truth for this slice:

- the existing estimate tables remain the canonical final output
- recommendation and review tables remain the source of truth for the pre-promotion workbench state
- promotion into the canonical estimate model only happens after estimator approval, as in the current estimating workflow

Concrete persistence model:

- keep `estimate_pricing_recommendations` as the parent recommendation row for one scope item under review
- add `estimate_pricing_recommendation_options` as child rows for ranked default and alternates
- store inferred missing-scope suggestions as recommendation rows with `source_type = 'inferred'`
- store manual-added rows as recommendation rows with `source_type = 'manual'`
- keep estimator decision history in review-event tables rather than mutating canonical estimate rows directly

Required additions:

- recommendation-option records for one recommendation set with multiple ranked candidates
- explicit source typing on recommendation rows:
  - `extracted`
  - `inferred`
  - `manual`
- local catalog source tagging for promoted custom rows
- selected-option linkage from the parent recommendation to the chosen option or chosen manual row
- stable source-row linkage for refresh and dedupe behavior
- deal and section linkage for promotion into canonical estimate sections

Write-path rules:

- generation creates or refreshes recommendation rows and option rows only
- estimator review mutates recommendation state and option selection state only
- promotion writes approved recommendation outcomes into the canonical estimate model
- canonical estimate rows are never edited directly by recommendation ranking actions

Each recommendation option should carry:

- catalog or custom reference
- rank
- confidence
- evidence payload
- pricing rationale
- whether it was recommended default or alternate

Catalog backing types should be distinguishable from synced Procore catalog items:

- `procore_synced`
- `local_promoted`
- `estimate_only`

Canonical meaning:

- `estimate_only` is only a manual-row backing type for rows with no catalog item
- it is not a source type and not a catalog table source

Parent recommendation rows should carry:

- current review status
- selected option id
- selected source type
- catalog backing type
- promotable flag
- promoted estimate line item id, nullable until promotion
- inference rationale summary for inferred rows

Required linkage fields:

- `deal_id`
- `estimate_section_name`
- `source_document_id`, nullable for manual rows
- `source_extraction_id`, nullable for inferred or manual rows
- `source_row_identity`
- `generation_run_id`
- `manual_origin` with allowed values:
  - `generated`
  - `manual_estimator_added`
- `selected_option_id`, nullable until selection exists
- `catalog_backing` with allowed values:
  - `procore_synced`
  - `local_promoted`
  - `estimate_only`
- `promoted_estimate_line_item_id`, nullable until promotion exists
- `promoted_local_catalog_item_id`, nullable until local catalog promotion exists
- `manual_label`, nullable unless `source_type = 'manual'`
- `manual_quantity`, nullable unless `source_type = 'manual'`
- `manual_unit`, nullable unless `source_type = 'manual'`
- `manual_unit_price`, nullable unless `source_type = 'manual'`
- `manual_notes`, nullable unless `source_type = 'manual'`
- `override_quantity`, nullable unless the row is overridden
- `override_unit`, nullable unless the row is overridden
- `override_unit_price`, nullable unless the row is overridden
- `override_notes`, nullable unless the row is overridden

Required option-row linkage fields:

- `recommendation_id`
- `catalog_item_id`, nullable for free-text custom options
- `local_catalog_item_id`, nullable unless sourced from local catalog
- `rank`
- `option_label`
- `option_kind`:
  - `recommended`
  - `alternate`
  - `manual_custom` (only for manual rows that are catalog-backed alternatives, not free-text estimate-only rows)

Uniqueness and refresh rules:

- one recommendation row per `generation_run_id + source_row_identity`
- one option row per `recommendation_id + rank`
- rerunning generation creates a new generation run and a new recommendation set rather than mutating prior runs in place
- dedupe within a single generation run uses the duplicate suppression rules in this spec
- promotion idempotency is enforced by `promoted_estimate_line_item_id`; a row with that field set must not promote again

Manual row storage contract:

- manual free-text rows are persisted on the parent recommendation row (`manual_*` fields)
- for manual free-text rows:
  - `catalog_backing = 'estimate_only'`
  - `manual_origin = 'manual_estimator_added'`
  - `selected_option_id = null`
  - `generation_run_id` is set to the active generation run in the current workbench context; if no active run exists, create a synthetic manual generation run for the deal and use that id
- if a manual row is catalog-backed or later mapped to catalog alternatives:
  - keep parent `manual_*` fields as the estimator-authored baseline
  - store catalog candidates as child option rows
  - set `selected_option_id` when a catalog candidate is chosen

`source_row_identity` definition:

- for extracted rows: `extraction:<source_extraction_id>`
- for inferred rows: `inferred:<normalized_intent>:<estimate_section_name>`
- for manual rows: `manual:<normalized_intent>:<estimate_section_name>:<manual_label>`

This field must be persisted directly on the recommendation row so refresh and dedupe logic do not depend on nullable foreign keys alone.

`normalized_intent` contract:

- lowercase
- trim leading and trailing whitespace
- collapse repeated internal whitespace to one space
- remove non-semantic punctuation
- normalize common unit and scope aliases through a fixed alias map for this slice
- do not include section name inside `normalized_intent`; section-specific uniqueness is handled by `source_row_identity`

## Local Catalog Model

This slice assumes the existing synced catalog remains intact and adds a local extension layer rather than a separate catalog product.

Concrete persistence target:

- keep Procore-synced catalog records in the current public catalog source/version model
- add a new tenant-scoped table for local promoted catalog items rather than forcing them into the public source/version sync model
- unified catalog search merges:
  - public Procore-synced catalog search results
  - tenant-scoped local promoted catalog item results

Persistence rules:

- keep synced Procore items in the current catalog mirror
- add local promoted items to a tenant-scoped local catalog table with `catalog_source = 'local_promoted'`
- manual rows that are not promoted remain `estimate_only` and are not globally searchable

Server responsibilities:

- catalog search endpoint returns both `procore_synced` and `local_promoted` results in one list
- manual-add flow can create either:
  - a catalog-backed recommendation row
  - an estimate-only custom recommendation row
- promote-to-local-catalog creates a reusable local catalog item immediately and links the originating recommendation row to that new local item

Client responsibilities:

- manual add defaults to catalog search first
- custom free-text entry is a fallback when search is not sufficient
- promoted custom items become searchable in future manual-add and ranking flows

Minimum persisted fields for local promoted items:

- office id / tenant scope
- source type = `local_promoted`
- source label
- normalized name
- optional description
- default unit
- optional default pricing hints
- created from deal id
- created from recommendation id
- catalog source tag

This slice does not require a separate approval queue or a separate local-catalog management UI.

## Ranking Logic

Ranking should combine multiple signals rather than choosing a line from a single matching pass.

Primary signals:

- extraction-to-catalog similarity
- historical co-occurrence with similar jobs
- historical selection outcomes from prior estimator reviews
- pricing plausibility against known baselines
- unit and quantity compatibility

The system should output:

- one recommended default
- ranked alternates
- explicit rationale fields rather than opaque confidence alone

Deterministic ranking rules:

- only options above a minimum eligibility threshold are shown
- if multiple options are eligible, sort by:
  1. total weighted score
  2. historical selection frequency for similar jobs
  3. tighter unit compatibility
  4. lower absolute price deviation from historical median
  5. stable id ordering as final tie-break
- return at most one recommended default plus up to four alternates
- suppress duplicate options that resolve to the same catalog item or same normalized custom item

Deterministic scoring inputs for this slice:

- catalog similarity score
- historical co-occurrence score
- historical acceptance score
- unit compatibility score
- price plausibility score

Weights can be tuned later, but the implementation plan should treat the ordering above as the deterministic contract for tie-breaks and duplicate suppression.

## Missing Scope Logic

Missing-scope detection should be allowed even when the item was not directly extracted from OCR, but inferred items must remain clearly labeled.

Inference sources may include:

- spec text implying required companion work
- assemblies commonly paired in similar estimates
- historical co-occurrence patterns
- dependencies implied by selected catalog items

An inferred row should include:

- why it was inferred
- which source rows/spec text/history supported it
- confidence
- its current review-required state

Deterministic inference rules:

- only infer a row if at least one explicit source signal exists and at least one historical or dependency signal supports it
- do not infer duplicate rows when an extracted or already-manual row with the same normalized intent already exists
- inferred rows default to `needs_review`
- inferred rows never skip straight to approved pricing
- inferred rows use the same ranked-option model as extracted rows once created

Persistence rule:

- `needs_review` is the presentation label for the persisted parent-row state `pending_review`

Duplicate suppression order:

1. exact normalized catalog intent match
2. same selected catalog item id
3. same normalized manual custom line label within the same section

If a duplicate is detected, prefer the explicit extracted row over inferred scope.

If a manual row overlaps:

- manual beats inferred
- extracted beats inferred
- extracted and manual may both remain visible, but no new inferred suggestion should be generated for that normalized intent in that section

Explicit-row duplicate rule for this slice:

- extracted and manual rows with the same normalized intent or selected catalog item are not auto-collapsed
- instead, both remain visible and the workbench flags them as a duplicate-review condition for the estimator
- duplicate suppression only removes inferred rows when an explicit extracted or manual row already covers that intent

## Review Lifecycle

Recommendation rows stay inside the workbench until promotion.

States for parent recommendation rows:

- `pending_review`
- `accepted`
- `alternate_selected`
- `overridden`
- `rejected`

Promotion model:

- `promoted` is not a separate review state
- promotion is orthogonal and is represented by `promoted_estimate_line_item_id`
- a row can therefore be:
  - `accepted` and not yet promoted
  - `accepted` and already promoted
  - `alternate_selected` and already promoted
  - `overridden` and already promoted
- `rejected` rows are never promotable

Concrete promote action:

- there is a separate explicit promote action in the workbench
- accept, alternate select, and override do not auto-promote
- the explicit promote action writes canonical estimate lines for the current promotable set or a selected subset

Post-promotion edit rule for this slice:

- once `promoted_estimate_line_item_id` is set, review-selection and override actions on that recommendation row are blocked
- changing a promoted row requires an explicit reopen flow in a later slice; reopening is out of scope here
- this keeps canonical estimate lines and workbench state from diverging in this slice

Promotable review states:

- `accepted`
- `alternate_selected`
- `overridden`

Allowed actions:

- accept recommended:
  - marks the parent row `accepted`
  - records the recommended option as selected
- accept manual row:
  - applies only to rows with `source_type = 'manual'`
  - marks the parent row `accepted`
  - keeps `selected_option_id = null` when the row is still free-text estimate-only
  - uses the persisted `manual_*` fields as the canonical values for later promotion unless an override is applied
- switch to alternate:
  - marks the parent row `alternate_selected`
  - records the chosen alternate option id
- override:
  - marks the parent row `overridden`
  - stores overridden quantity/unit/price values on the parent recommendation row in `override_*` fields
  - keeps a matching review event for audit
- reject:
  - marks the parent row `rejected`
  - keeps audit evidence but removes it from promotable output
- add missing item:
  - creates a new parent recommendation row with `source_type = 'manual'`
  - persists estimator-entered manual fields on the parent row
  - optionally links it to catalog-backed child options
  - uses `catalog_backing = 'estimate_only'` when no catalog option is selected
  - leaves the row in `pending_review` until the estimator explicitly accepts it or overrides it
- promote custom row to local catalog:
  - creates a reusable local catalog item
  - writes its id to `promoted_local_catalog_item_id` on the parent recommendation row
  - does not itself promote the line into the canonical estimate model
  - must no-op and return the existing linked item when `promoted_local_catalog_item_id` is already set on that recommendation row

Audit behavior:

- every action emits a review event
- review events store before/after state and selected option references
- promotion into the canonical estimate model only reads rows in:
  - `accepted`
  - `alternate_selected`
  - `overridden`
  where `promoted_estimate_line_item_id` is null

## Promotion Mapping

Promotion into the canonical estimate model must support both catalog-backed and manual rows.

Section resolution contract:

- recommendation rows persist `estimate_section_name` as the canonical section grouping field for this slice
- promotion first looks up an existing estimate section for the deal by exact section name
- if found, reuse it
- if not found, create it
- implementation should not invent an alternate section-key system for this slice

Catalog-backed row mapping:

- section is resolved from `estimate_section_name`
- description comes from the selected option label or catalog item name
- quantity, unit, unit price, and total come from the selected or overridden values
- notes include rationale and optionally selected catalog/source references

Manual estimate-only row mapping:

- section is resolved from `estimate_section_name`
- description comes from `manual_label`
- quantity, unit, unit price, and total come from the estimator-entered manual values
- no catalog id is required
- notes should preserve that the row originated as `estimate_only`

Manual promoted-local-catalog row mapping:

- same canonical estimate mapping as manual estimate-only rows
- if the row remains free-text, the parent recommendation row links to the promoted local catalog item through `promoted_local_catalog_item_id`
- if the row later selects a catalog-backed child option, the selected option row may also carry the local catalog linkage
- promotion mapping must prefer `promoted_local_catalog_item_id` on the parent recommendation row when `selected_option_id` is null
- if both `promoted_local_catalog_item_id` and `selected_option_id` are present, the selected option is the source of truth for description, quantity, unit, and price, while the parent local-catalog link remains provenance only

Promotion completion behavior:

- create the canonical estimate line item
- write its id to `promoted_estimate_line_item_id`
- emit a promotion review event
- repeated promotion attempts for the same recommendation row must no-op if `promoted_estimate_line_item_id` is already set

## Manual Add and Catalog Promotion

Estimators should be able to add missing items in this slice.

Manual add flow:

- catalog-first search against synced and local catalog items
- free-text custom fallback
- editable quantity, unit, unit price, and notes
- required section selection using `estimate_section_name`

Manual recommendation persistence:

- free-text manual rows persist `estimate_section_name`, `manual_label`, `manual_quantity`, `manual_unit`, `manual_unit_price`, and `manual_notes` on the parent recommendation row before promotion
- free-text manual rows also persist `generation_run_id`, `manual_origin`, and `source_row_identity` on the parent recommendation row using the contracts above
- if a manual row is later promoted to the local catalog, the new local catalog item is created from those persisted manual fields and linked back through `promoted_local_catalog_item_id` on the parent recommendation row

Manual row refresh behavior:

- manual rows are not discarded when a new generation run is created
- on rerun, unresolved manual rows for the deal that are not rejected and not already promoted are carried forward into the new active generation run
- carry-forward keeps the same `source_row_identity`, `manual_*` fields, and latest review state so the estimator does not lose manually added work
- promoted or rejected manual rows remain attached to their historical run for audit and are not copied into the new active run

Custom lines can be promoted immediately into the local catalog for reuse later. This is acceptable for the current demonstrative scope and avoids introducing approval workflow complexity in this slice.

Promoted local catalog rows should still be tagged as locally promoted so future ranking and analytics can distinguish them from Procore-synced master items.

## UI Direction

The line-item review table remains the primary surface.

Default row fields:

- label
- quantity
- unit
- recommended unit price
- recommended total
- confidence
- source badge:
  - `extracted`
  - `inferred`
  - `manual`

Evidence panel fields:

- ranked alternates
- matched catalog references
- similar historical line items
- price rationale
- omission rationale for inferred rows
- review actions
- promote-to-local-catalog action for custom rows

The UI should optimize for fast estimator decisions, not exploratory browsing.

## Error Handling

This slice must degrade gracefully.

- if alternates cannot be generated, still show the default recommendation
- if omission detection fails, do not block line review
- if catalog promotion fails, preserve the custom estimate row and surface the promotion error separately
- if historical evidence is sparse, show low-confidence rationale rather than hiding the row

## Testing

Tests should cover:

- ranked alternates attached to a recommendation set
- inferred missing rows clearly separated from extracted rows
- manual add flow producing reviewable rows
- custom row promotion into the local catalog with source tagging
- recommendation choice changes being stored as review signals
- line-level override and rejection behaviors
- omission rationale appearing only on inferred rows
- fallback behavior when alternates or omission inference are unavailable

## Scope Boundaries

This slice does not include:

- market-rate integration overhaul
- package-level approval workflow
- approval workflow for promoted local catalog items
- autonomous estimate finalization

It is intentionally focused on estimate-quality review inside the current estimator workbench.
