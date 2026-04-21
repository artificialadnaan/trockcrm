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
- `source_type` is immutable row origin and never changes after row creation
- `selected_source_type` is the current chosen content source for pricing and promotion and may differ from `source_type` after review actions
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
- derived promotable flag
- promoted estimate line item id, nullable until promotion
- inference rationale summary for inferred rows

`promotable` is a derived workflow field, not a separately stored source of truth. A row is promotable only when:

- review state is `accepted`, `alternate_selected`, or `overridden`
- `promoted_estimate_line_item_id` is null
- the row is not blocked by duplicate-review gating
- the row satisfies any baseline-selection requirements for override/promotion in this spec

Required linkage fields:

- `deal_id`
- `estimate_section_name`
- `source_type` with allowed values:
  - `extracted`
  - `inferred`
  - `manual`
- `source_document_id`, nullable for manual rows
- `source_extraction_id`, nullable for inferred or manual rows
- `normalized_intent`
- `source_row_identity`
- `generation_run_id`
- `manual_origin`, nullable unless `source_type = 'manual'`, with allowed values:
  - `generated`
  - `manual_estimator_added`
- `selected_source_type`, nullable until a recommendation or manual row is accepted, with allowed values:
  - `manual`
  - `catalog_option`
- `selected_option_id`, nullable until selection exists
- `catalog_backing`, nullable until selection exists for extracted/inferred rows, with allowed values:
  - `procore_synced`
  - `local_promoted`
  - `estimate_only`
- `promoted_estimate_line_item_id`, nullable until promotion exists
- `promoted_local_catalog_item_id`, nullable until local catalog promotion exists
- `manual_label`, nullable unless `source_type = 'manual'`
- `manual_identity_key`, nullable unless `source_type = 'manual'`
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
- rerun carry-forward for manual rows is implemented as cloning qualifying manual recommendation rows into the new generation run; historical rows keep their original `generation_run_id`
- dedupe within a single generation run uses the duplicate suppression rules in this spec
- promotion idempotency is enforced by `promoted_estimate_line_item_id`; a row with that field set must not promote again

Manual row storage contract:

- manual free-text rows are persisted on the parent recommendation row (`manual_*` fields)
- for manual free-text rows:
  - `catalog_backing = 'estimate_only'`
  - `manual_origin = 'manual_estimator_added'`
  - `selected_source_type = null` until the row is explicitly accepted
  - `selected_option_id = null`
  - `generation_run_id` is set to the active generation run in the current workbench context; if no active run exists, create a synthetic manual generation run for the deal and use that id
  - `manual_identity_key` is generated once when the row is created and remains stable across later edits to label, section, quantity, unit, price, notes, and free-text versus catalog-backed mode changes
  - mint a new `manual_identity_key` only when the estimator explicitly creates a separate new manual row, not when editing an existing one
- if a manual row is catalog-backed or later mapped to catalog alternatives:
  - keep parent `manual_*` fields as the estimator-authored baseline
  - flip `catalog_backing` to `procore_synced` or `local_promoted` based on the selected option source
  - keep `selected_source_type = null` while the row is still `pending_review`
  - set `selected_source_type = 'catalog_option'` only when the row is explicitly accepted, switched, or otherwise selected for promotion
  - store catalog candidates as child option rows
  - set `selected_option_id` when a catalog candidate is chosen
  - if the estimator creates the manual row by selecting a catalog result in the add-item flow, create it in `pending_review` with that option preselected
  - if that preselected catalog result is an existing local catalog item, persist it only through the child option row plus `selected_option_id`; do not write `promoted_local_catalog_item_id` because no new local catalog item was created
  - estimator-created catalog-backed manual rows still use `manual_origin = 'manual_estimator_added'`
  - rerun carry-forward clones of manual rows use `manual_origin = 'generated'`
- if the estimator switches a catalog-backed manual row back to free-text:
  - clear `selected_option_id`
  - set `selected_source_type = 'manual'`
  - set `catalog_backing = 'estimate_only'`
  - keep `manual_*`, `manual_identity_key`, and `normalized_intent` as the active free-text baseline

`source_row_identity` definition:

- for extracted rows: `extraction:<source_extraction_id>`
- for inferred rows: `inferred:<normalized_intent>:<canonicalized_estimate_section_name>`
- for manual rows: `manual:<manual_identity_key>`

This field must be persisted directly on the recommendation row so refresh and dedupe logic do not depend on nullable foreign keys alone.

`normalized_intent` contract:

- lowercase
- trim leading and trailing whitespace
- collapse repeated internal whitespace to one space
- remove non-semantic punctuation
- normalize common unit and scope aliases through a fixed alias map for this slice
- do not include section name inside `normalized_intent`; section-specific uniqueness is handled by `source_row_identity`
- manual rows derive and persist `normalized_intent` from `manual_label` using this same contract at create time and recompute it when the estimator edits the manual label

`estimate_section_name` canonicalization contract:

- trim leading and trailing whitespace before persistence
- collapse repeated internal whitespace to one space
- compare section identity case-insensitively using a lowercase canonical form
- promotion lookup and duplicate grouping compare section names using this canonicalized value
- implementation may preserve a display label casing separately, but identity and reuse must use the canonicalized section name

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
  - a `normalized custom item` uses the existing `normalized_intent` contract over the custom/manual label plus the canonicalized section scope

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

- an `explicit source signal` means direct document-backed evidence such as extracted scope text, sheet/spec text, or an accepted extracted row tied to uploaded project documents
- only infer a row if at least one explicit source signal exists and at least one historical or dependency signal supports it
- do not infer duplicate rows when an extracted or already-manual row with the same normalized intent already exists
- inferred rows default to `needs_review`
- inferred rows never skip straight to approved pricing
- inferred rows use the same ranked-option model as extracted rows once created

Persistence rule:

- `needs_review` is the presentation label for the persisted parent-row state `pending_review`

Duplicate grouping and inferred-suppression order:

1. same selected catalog item id within the same section
2. same normalized intent within the same section for extracted or inferred rows
3. same normalized intent within the same section for manual rows

All duplicate-review grouping in this slice is section-scoped. For explicit extracted/manual rows, this ordered list defines duplicate-review grouping signals rather than auto-suppression behavior; only inferred rows are actually suppressed by these rules.

If a duplicate is detected, prefer the explicit extracted row over inferred scope.

This explicit-over-inferred preference applies before canonical promotion. Once any row in the duplicate group has already been promoted, the promoted row remains the canonical winner for this slice unless a later reopen/supersede flow is introduced.

If a manual row overlaps:

- manual beats inferred
- extracted beats inferred
- extracted and manual may both remain visible, but no new inferred suggestion should be generated for that normalized intent in that section

Explicit-row duplicate rule for this slice:

- extracted and manual rows with the same normalized intent or selected catalog item are not auto-collapsed
- instead, both remain visible and the workbench flags them as a duplicate-review condition for the estimator
- duplicate suppression only removes inferred rows when an explicit extracted or manual row already covers that intent
- duplicate-review grouping is determined by same `estimate_section_name` plus either matching `normalized_intent` or matching selected catalog item id
- only one row in a duplicate-review group may remain promotable; when multiple rows in the group are simultaneously eligible, all of them are duplicate-blocked until the estimator rejects or returns enough rows to `pending_review` so exactly one promotable row remains
- carried-forward clones must re-evaluate duplicate-review grouping against already-promoted rows for the deal, so a group with an already promoted winner stays blocked until the remaining rows are edited into a different group or rejected
- the first promoted row in a duplicate-review group becomes the canonical winner for that deal in this slice; later rows in the same group cannot supersede it without a separate reopen/supersede flow, which is out of scope here
- when no prior winner exists, a duplicate group only gets a winner from a promotion request that contains exactly one promotable row from that group
- if a later promotion attempt targets a row in a duplicate-review group that already has a canonical winner, the promote action must fail with a duplicate-blocked result and create no canonical estimate line

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
- batch promote is row-scoped, not all-or-nothing: eligible rows promote independently, while blocked rows return row-level errors and create no canonical estimate line
- batch promote must pre-validate duplicate-review groups and refuse to promote multiple rows from the same duplicate group in a single batch; all rows in that conflicting group return duplicate-blocked results

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
  - sets `selected_source_type = 'catalog_option'`
  - sets `catalog_backing` from the selected option source:
    - `procore_synced` when the option references a synced catalog item
    - `local_promoted` when the option references a local catalog item
- accept manual row:
  - applies only to rows with `source_type = 'manual'`
  - marks the parent row `accepted`
  - keeps `selected_source_type = 'manual'` and `selected_option_id = null` when the row is still free-text estimate-only
  - if the manual row has a preselected catalog option, sets `selected_source_type = 'catalog_option'` and keeps the preselected `selected_option_id`
  - uses the persisted `manual_*` fields as the canonical values for later promotion unless an override is applied
- switch to alternate:
  - marks the parent row `alternate_selected`
  - records the chosen alternate option id
  - sets `selected_source_type = 'catalog_option'`
  - sets `catalog_backing` from the chosen option source:
    - `procore_synced` when the option references a synced catalog item
    - `local_promoted` when the option references a local catalog item
- override:
  - marks the parent row `overridden`
  - requires a selected baseline before override:
    - extracted or inferred rows must already have `selected_option_id`
    - manual rows may override either a free-text manual baseline or a selected catalog option
  - stores overridden quantity/unit/price values on the parent recommendation row in `override_*` fields
  - keeps a matching review event for audit
  - when `override_*` fields are present, they take precedence over selected option or manual baseline values during promotion; `selected_option_id` remains provenance only
- reject:
  - marks the parent row `rejected`
  - keeps audit evidence but removes it from promotable output
- return to pending review:
  - applies when an estimator wants to keep a row visible but make it non-promotable
  - sets the parent row back to `pending_review`
  - is the explicit demotion action used to resolve duplicate-review groups without rejecting the row
- add missing item:
  - creates a new parent recommendation row with `source_type = 'manual'`
  - persists estimator-entered manual fields on the parent row
  - optionally links it to catalog-backed child options
  - uses `catalog_backing = 'estimate_only'` when no catalog option is selected
  - leaves the row in `pending_review` until the estimator explicitly accepts it or overrides it
- promote custom row to local catalog:
  - applies only to free-text custom manual rows that do not currently have a selected catalog-backed child option
  - creates a reusable local catalog item
  - writes its id to `promoted_local_catalog_item_id` on the parent recommendation row
  - flips `catalog_backing` to `local_promoted`
  - keeps `source_type = 'manual'` because row origin does not change
  - keeps `selected_source_type = null` while the row is still `pending_review`; once the row is accepted as free-text it becomes `manual`, and if the estimator later chooses a catalog-backed child option it becomes `catalog_option`
  - does not itself promote the line into the canonical estimate model
  - must no-op and return the existing linked item when `promoted_local_catalog_item_id` is already set on that recommendation row
  - must also no-op and reuse an existing local catalog item when another recommendation row for the same `deal_id + manual_identity_key` has already linked one
  - automatic local-catalog reuse is deal-local for this slice; promoting equivalent manual content from a different deal creates a new tenant-scoped local catalog item unless future catalog-dedupe work says otherwise
  - in a different deal, estimators may still search and select an existing tenant-scoped local catalog item directly through the catalog-first flow instead of promoting a new custom row

Audit behavior:

- every action emits a review event
- review events store before/after state and selected option references
- promotion into the canonical estimate model only reads rows in:
  - `accepted`
  - `alternate_selected`
  - `overridden`
  where `promoted_estimate_line_item_id` is null
  and where the row is not blocked by an unresolved duplicate-review group

## Promotion Mapping

Promotion into the canonical estimate model must support both catalog-backed and manual rows.

Section resolution contract:

- recommendation rows persist `estimate_section_name` as the canonical section grouping field for this slice
- promotion first looks up an existing estimate section for the deal by exact section name
- that exact lookup uses the canonicalized `estimate_section_name` value, not raw user-entered whitespace or casing
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
- if the row remains free-text, the parent recommendation row links to the promoted local catalog item through `promoted_local_catalog_item_id`, but canonical estimate promotion still uses the effective manual baseline or override values for description, quantity, unit, and price
- if the row later selects a catalog-backed child option, the selected option row may also carry the local catalog linkage
- when `selected_option_id` is null, `promoted_local_catalog_item_id` is provenance and reuse linkage only, not the source of truth for canonical estimate values
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

- free-text manual rows persist `estimate_section_name`, `manual_label`, `manual_identity_key`, `manual_quantity`, `manual_unit`, `manual_unit_price`, and `manual_notes` on the parent recommendation row before promotion
- free-text manual rows also persist `normalized_intent` derived from `manual_label` using the contract above
- free-text manual rows also persist `generation_run_id`, `manual_origin`, and `source_row_identity` on the parent recommendation row using the contracts above
- if a manual row is later promoted to the local catalog, the new local catalog item is created from those persisted manual fields and linked back through `promoted_local_catalog_item_id` on the parent recommendation row
- if `override_*` values exist at local-catalog promotion time, seed the new local catalog item from the effective overridden values instead of the pre-override manual baseline

Manual row refresh behavior:

- manual rows are not discarded when a new generation run is created
- on rerun, unresolved manual rows for the deal that are not rejected and do not already have `promoted_estimate_line_item_id` are cloned into the new active generation run
- carry-forward clones keep the same `source_row_identity`, `manual_*` fields, `manual_identity_key`, latest review state, and `promoted_local_catalog_item_id` so the estimator does not lose manually added work
- carry-forward clones also preserve `selected_option_id`, `selected_source_type`, `catalog_backing`, and any `override_*` fields so the resolved manual-row state is reconstructed in the new run
- when a carried-forward manual row references catalog-backed child options, clone those option rows into the new recommendation set and remap `selected_option_id` to the cloned option row in the new run
- rows with only `promoted_local_catalog_item_id` still carry forward if they have not yet been promoted into the canonical estimate model
- rejected rows and rows with `promoted_estimate_line_item_id` remain attached to their historical run for audit and are not copied into the new active run

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

## Migration and Backfill

This slice does not backfill legacy draft estimates into the new recommendation-review model.

- existing canonical estimate rows remain intact and are not rewritten
- historical recommendation rows that predate these required workflow fields are treated as legacy and are not relied on by the new workbench
- the new workflow applies to recommendation rows created or regenerated after this slice lands
- if an older draft needs to enter the new workflow, the implementation should create a fresh generation run and new recommendation rows rather than guessing backfilled `source_row_identity`, `generation_run_id`, or `manual_origin` values
