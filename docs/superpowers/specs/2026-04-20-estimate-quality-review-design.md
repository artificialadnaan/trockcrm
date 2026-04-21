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

Likely additions:

- recommendation-option records for one recommendation set with multiple ranked candidates
- inferred-scope records or a typed flag on recommendation rows
- manual-added-row records or typed recommendation rows authored by estimators
- local catalog source tagging for promoted custom rows

Each recommendation option should carry:

- catalog or custom reference
- rank
- confidence
- evidence payload
- pricing rationale
- whether it was recommended default or alternate

Custom promoted catalog items should be distinguishable from synced Procore catalog items:

- `procore_synced`
- `local_promoted`
- `estimate_only`

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

## Manual Add and Catalog Promotion

Estimators should be able to add missing items in this slice.

Manual add flow:

- catalog-first search against synced and local catalog items
- free-text custom fallback
- editable quantity, unit, unit price, and notes

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
- source badge: `extracted` or `inferred`

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
