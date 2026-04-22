# Estimating Market-Rate Enrichment Design

## Summary

Add an internal market-rate pricing layer to the estimating workflow so draft pricing can be adjusted by project geography before estimator review. The feature should resolve a project market from ZIP first, fall back to broader geography when needed, apply separate labor/material/equipment adjustments, and show those adjustments in the existing pricing evidence model. Estimators must be able to override the resolved market when the automatic mapping is wrong.

This slice extends the existing estimate-quality workflow. It does not replace historical pricing, catalog matching, or estimator review.

## Goals

- Add market-aware pricing adjustments to estimate recommendations.
- Resolve project geography primarily from ZIP and metro mappings.
- Preserve a provider-agnostic architecture so external data sources can be added later.
- Show labor, material, and equipment adjustment components in pricing evidence.
- Let estimators override the detected market from the estimating workbench.
- Keep the final output as a single recommended unit price and total per row.

## Non-Goals

- Third-party market data provider integration in this slice.
- Procore write-back or export changes.
- A separate market-pricing application outside the estimating workflow.
- Replacing historical bid data as the primary pricing baseline.
- Reworking the estimate promotion model.

## Recommended Approach

Build an internal market-rate engine first, using normalized geography and internal adjustment rules. The engine should operate behind a pricing interface so future provider-backed enrichment can be layered in later. Geography should resolve by ZIP to metro when possible, then fall back to region/state bands, then finally to a global default.

This is preferable to starting with a third-party provider because it ships faster, is easier to validate against historical estimates, avoids immediate vendor lock-in, and keeps the pricing rationale legible to estimators.

## User Experience

### Workbench pricing evidence

The existing estimating workbench remains the main review surface. Each pricing row should include market-rate rationale in the evidence panel:

- resolved market name
- geography source: ZIP, metro fallback, region/state fallback, or default
- baseline price before market-rate adjustment
- labor adjustment component
- material adjustment component
- equipment adjustment component
- final recommended unit price and total
- whether the market was auto-detected or manually overridden

The pricing row remains a single approvable line item. Market-rate inputs support the recommendation; they do not become a separate approval workflow.

### Market override

Estimators must be able to override the resolved market from the workbench. The override should be tied to the deal, not to a single row, because the pricing context is project-wide. Once overridden:

- the deal’s estimating workflow uses the override market instead of the auto-resolved one
- refreshed pricing recommendations use the override market
- the review log records the override and the prior market
- the evidence panel clearly shows the override is in effect

### Failure and fallback behavior

If the project location cannot be resolved to a ZIP or metro mapping, the pricing engine should fall back to broader geography and still produce a recommendation. The evidence should disclose when fallback pricing was used. Missing geography should never silently disable estimate generation.

## Architecture

### Pricing flow

The market-rate layer sits inside the existing estimate pricing path:

1. historical/catalog baseline is resolved for a pricing recommendation
2. project geography is normalized from the deal
3. active market is resolved from ZIP to metro to region/state to default
4. adjustment rules are loaded for that market and pricing scope
5. labor/material/equipment adjustments are applied
6. the final recommended unit price and total are stored back on the pricing recommendation
7. rationale/evidence records the applied market logic

### Provider-agnostic interface

The internal engine should be wrapped behind an interface such as `MarketRateProvider` or `MarketRateAdjustmentResolver`. The first implementation uses internal rules from local tables. A later provider-backed implementation should be swappable without changing workbench routes or pricing review logic.

### Scope matching

Adjustment rules should key off normalized pricing scope, not arbitrary UI labels. At minimum, rules should support a match hierarchy such as:

- exact market + division/trade
- exact market + general scope
- region/state + division/trade
- region/state + general scope
- default global rule

This keeps the system generic enough for general-contractor workflows without hardcoding trade-specific behavior into the core model.

## Data Model

### New tables

- `estimate_markets`
  - canonical market records
  - name, slug, type, state/region metadata, active flag

- `estimate_market_zip_mappings`
  - ZIP to market mapping
  - ZIP, market id, confidence/source metadata

- `estimate_market_adjustment_rules`
  - effective pricing rules per market and scope
  - market id nullable for fallback/default rules
  - scope key / division key / project type key as needed
  - labor adjustment percent
  - material adjustment percent
  - equipment adjustment percent
  - effective start/end dates
  - priority / fallback ordering

- `estimate_deal_market_overrides`
  - per-deal override state
  - deal id, market id, override user id, reason, timestamps

### Extensions to existing estimating records

Pricing recommendation evidence or assumptions should include:

- resolved market id/name
- geography resolution level
- baseline unit price
- component adjustments
- adjusted unit price
- override metadata when applicable

This slice should avoid duplicating recommendation tables. Market-rate data should attach to the existing pricing recommendation model and workbench state responses.

## APIs and Services

### Services

- `market-resolution-service`
  - resolve a deal’s effective market from project ZIP and override state

- `market-rate-service`
  - load the active market adjustment rule for a pricing scope
  - compute labor/material/equipment adjustments
  - produce normalized rationale output

- `deal-market-override-service`
  - apply, clear, and audit estimator overrides

### Routes

Add estimating endpoints to:

- get resolved market context for a deal
- set or clear a deal market override
- return market-rate evidence as part of workbench pricing rows

The existing pricing-generation workflow should call the market-rate service automatically. Estimators should not need to run a separate pricing step.

## Pricing Logic

### Baseline and components

Historical estimates and catalog-based pricing remain the baseline. Market-rate enrichment adjusts the baseline by component:

- labor changes most frequently by geography and should usually have the strongest signal
- material adjustments can be lighter and may fall back sooner
- equipment adjustments should be applied where rules exist, otherwise fall back to default

The system should still emit:

- one adjusted recommended unit price
- one adjusted recommended total

The component values exist for rationale, tuning, and future expansion.

### Suggested calculation model

The first version can use a weighted additive component model:

- derive baseline unit price
- split or approximate baseline into labor/material/equipment weighting by scope rule
- apply component percentage adjustments
- recombine into adjusted unit price

If a scope rule does not define component weights, use configured defaults. This keeps the model implementable now without pretending every item already has perfect cost decomposition.

## Review and Audit

All market overrides should create estimating review events. The review log should capture:

- previous market context
- new market context
- user id
- optional override reason

Pricing refreshes caused by an override should preserve traceability. Estimators need to understand whether a recommendation changed because of a market override, historical evidence, or a manual review action.

## Testing

### Server

- market resolution from ZIP
- metro fallback
- region/state fallback
- default fallback
- rule selection precedence
- component adjustment math
- effective-date rule filtering
- deal market override set/clear behavior
- pricing recommendation evidence includes market-rate details

### Client

- workbench evidence displays market-rate details
- deal-level market override controls render correctly
- override state appears in pricing rationale
- override-triggered refresh behavior updates the displayed recommendation context

### Integration

- estimate generation uses market-rate adjustments when geography exists
- estimate generation still works when geography resolution falls back
- override changes pricing context for subsequent review refreshes

## Risks and Mitigations

- Thin geography coverage can produce weak pricing signals.
  - Mitigation: use explicit fallback levels and show them in evidence.

- Estimators may distrust hidden pricing changes.
  - Mitigation: show baseline price and component adjustments in the rationale.

- Overly granular rule management can become operationally heavy.
  - Mitigation: start with ZIP-to-metro resolution plus fallback bands, not hyper-local custom rates.

- Future provider integration could force rework if this slice is too bespoke.
  - Mitigation: keep market-rate resolution behind a provider interface from the start.

## Rollout

Phase this slice behind an estimating feature flag if needed. The first rollout should prioritize:

1. internal market tables and ZIP/metro resolution
2. server-side pricing enrichment and rationale output
3. workbench evidence display
4. estimator market override controls

This sequencing keeps the feature useful early and avoids delaying pricing enrichment on UI-only concerns.
