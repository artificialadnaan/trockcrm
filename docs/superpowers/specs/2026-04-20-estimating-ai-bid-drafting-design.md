# Estimating AI Bid Drafting Design

**Date:** 2026-04-20
**Status:** Draft for review
**Scope:** Procore-synced catalog, uploaded-plan OCR extraction, historical bid pricing, market-rate refinement, estimator review workflow, and estimating copilot guidance

## Goal

Add an AI-assisted estimating workflow to the CRM's project estimating area that allows the team to:

- upload plans, blueprints, and specs
- extract scope signals from uploaded documents
- map extracted scope to a Procore-synced local cost catalog
- price draft estimates using catalog data, historical estimate data, and market-rate adjustments
- send a reviewer-ready draft estimate to the estimating team
- ask copilot questions about pricing strategy, historical win patterns, and line-item guidance

The first release should optimize for speed, accuracy, and competitive advantage without attempting to replace estimator judgment.

## Product Outcome

Phase 1 should produce a new estimating workflow inside the project estimating tab:

`Upload Documents -> Extraction -> Catalog Match -> Draft Pricing -> Estimator Review`

The result of the workflow is a draft estimate in the CRM's existing estimate section and estimate line-item structures, with all generated values remaining editable and reviewable by humans.

## What This Is

This feature is a document-to-draft-estimate system, not a CAD takeoff tool and not a fully autonomous bid engine.

The intended behavior is:

- estimators upload plans and supporting documents
- the system extracts scope, quantities, units, and classification hints from the documents
- the system matches those findings against the local Procore-backed catalog
- the pricing engine uses catalog costs, similar historical estimates, and regional market signals to recommend prices
- the CRM generates a draft estimate
- the estimator reviews, edits, approves, or rejects recommendations

## What This Is Not

Phase 1 should not include:

- pushing approved estimates back into Procore
- browser-based drawing or measurement tools
- hidden black-box pricing with no evidence
- direct replacement of estimator approval
- full autonomy for bid submission

## Design Principles

### 1. Human review is mandatory

The system may generate draft scope, pricing, and estimate lines, but the estimator remains the approval gate.

### 2. Procore is the upstream catalog authority

The CRM should sync the Procore cost catalog automatically and maintain a normalized local copy for matching, pricing, and analytics.

### 3. OCR is an extraction layer, not the system of record

Raw OCR output should never be treated as final pricing input. It should be converted into structured extraction records with evidence and confidence before matching and pricing occur.

### 4. Historical data should guide, not dominate

Historical estimates, awarded jobs, vendor/sub quotes, and internal production knowledge should all influence pricing recommendations, but every recommendation must show why it was made.

### 5. Evidence over vibes

Every generated match and pricing recommendation should retain source references such as page number, extracted text span, matched catalog item, similar historical jobs, and applied regional adjustments.

### 6. Keep the workflow inside estimating

The feature should live in the existing project estimating area so the team reviews AI outputs where estimates already exist.

## User Experience

The feature should appear inside the project estimating tab as a new guided workflow layered above the existing estimate editor.

Recommended subviews:

- `Overview`
- `Documents`
- `Extraction`
- `Catalog Match`
- `Draft Pricing`
- `Estimate`
- `Copilot`
- `Review Log`

### Overview

Shows project context, extraction status, sync status for the catalog snapshot used, pricing confidence summary, and reviewer actions needed.

### Documents

Allows upload of plans, blueprints, specs, and bid packages. Documents should be versioned and tied to the project.

### Extraction

Shows OCR-derived scope candidates such as item names, quantities, units, divisions, notes, and confidence, along with page and sheet references.

### Catalog Match

Shows the CRM's proposed mapping from extracted rows to Procore-synced catalog items and cost codes. Estimators can remap unmatched or low-confidence rows.

### Draft Pricing

Shows recommended material, labor, and blended prices based on:

- catalog pricing
- previous similar estimates
- prior awarded bids and margin outcomes where useful
- vendor/sub quote data when available
- market-rate adjustments by geography

### Estimate

Creates or updates the CRM's estimate sections and line items using approved draft rows. This should reuse the existing estimate editing experience instead of creating a second estimate model.

### Copilot

Provides advisory questions and answers such as:

- what types of bids have we historically won
- what similar jobs should we compare against
- why is this line item priced this way
- where is this estimate high or low compared to history
- what assumptions materially change this bid

### Review Log

Tracks accepted, edited, rejected, or overridden system recommendations so the team can audit decisions and improve the workflow over time.

## Recommended Architecture

The feature should be implemented as a pipeline with explicit stages rather than a single prompt.

### 1. Catalog Sync Layer

Synchronizes Procore cost catalog data into local CRM tables.

Responsibilities:

- fetch Procore catalog records on schedule or on demand
- normalize catalog items, codes, and price fields
- preserve source identifiers and sync metadata
- maintain active/inactive state and sync version history

### 2. Document Ingestion Layer

Stores uploaded estimating documents and prepares them for processing.

Responsibilities:

- file upload and storage
- document classification such as plan, blueprint, spec, or supporting package
- OCR execution and text extraction
- page-level metadata capture
- content hashing and reprocessing detection

### 3. Extraction Layer

Transforms OCR output into structured estimating signals.

Responsibilities:

- detect candidate scope items
- detect candidate quantities and units
- classify likely trade or division hints
- associate findings to source pages and text spans
- assign confidence and extraction method metadata

### 4. Matching Layer

Maps extracted scope to catalog and history-backed estimating concepts.

Responsibilities:

- rank likely catalog item matches
- match to cost codes or cost groups
- identify similar historical estimate line items
- surface ambiguous or missing mappings for review

### 5. Pricing Layer

Produces pricing recommendations using multiple evidence sources.

Responsibilities:

- seed prices from synced catalog data
- compare similar historical estimates and line items
- apply geographic market-rate adjustments
- account for project-type, division, and scope similarity
- produce recommended unit price, total price, assumptions, and confidence

### 6. Draft Estimate Layer

Converts approved pricing recommendations into draft estimate sections and line items using the existing estimate model.

### 7. Copilot Layer

Answers estimator questions against:

- project extraction outputs
- matched catalog items
- similar historical jobs
- win/loss outcomes when available
- pricing recommendations and assumptions

## Data Model Additions

Phase 1 should add new tables for both catalog storage and project-specific estimating workflow state.

### Catalog master data

#### `cost_catalog_sources`

Tracks external catalog sources and sync state.

Suggested fields:

- `id`
- `provider` such as `procore`
- `external_account_id`
- `name`
- `status`
- `last_synced_at`
- `last_successful_sync_at`
- `default_currency`
- `metadata_json`

#### `cost_catalog_sync_runs`

Stores audit history for each sync.

Suggested fields:

- `id`
- `source_id`
- `started_at`
- `completed_at`
- `status`
- `items_seen`
- `items_upserted`
- `items_deactivated`
- `error_summary`
- `metadata_json`

#### `cost_catalog_codes`

Stores normalized cost codes and hierarchy data.

Suggested fields:

- `id`
- `source_id`
- `external_id`
- `code`
- `name`
- `parent_code_id`
- `division`
- `phase_name`
- `phase_code`
- `is_active`
- `metadata_json`

#### `cost_catalog_items`

Stores normalized catalog items used for matching and pricing.

Suggested fields:

- `id`
- `source_id`
- `external_id`
- `item_type`
- `name`
- `description`
- `unit`
- `catalog_name`
- `catalog_number`
- `manufacturer`
- `supplier`
- `taxable`
- `is_active`
- `metadata_json`

#### `cost_catalog_item_codes`

Join table between items and codes.

Suggested fields:

- `id`
- `catalog_item_id`
- `catalog_code_id`
- `is_primary`

#### `cost_catalog_prices`

Stores cost values and pricing dimensions.

Suggested fields:

- `id`
- `catalog_item_id`
- `material_unit_cost`
- `labor_unit_cost`
- `equipment_unit_cost`
- `subcontract_unit_cost`
- `blended_unit_cost`
- `effective_at`
- `expires_at`
- `metadata_json`

### Project estimating workflow data

#### `estimate_source_documents`

Stores uploaded plans, specs, and related files.

Suggested fields:

- `id`
- `project_id`
- `deal_id`
- `document_type`
- `filename`
- `storage_key`
- `mime_type`
- `file_size`
- `version_label`
- `uploaded_by_user_id`
- `content_hash`
- `ocr_status`
- `parsed_at`
- `created_at`

#### `estimate_document_pages`

Stores page-level OCR and document metadata.

Suggested fields:

- `id`
- `document_id`
- `page_number`
- `sheet_label`
- `sheet_type`
- `ocr_text`
- `page_image_key`
- `metadata_json`

#### `estimate_extractions`

Stores structured scope or quantity candidates extracted from documents.

Suggested fields:

- `id`
- `project_id`
- `deal_id`
- `document_id`
- `page_id`
- `extraction_type`
- `raw_label`
- `normalized_label`
- `quantity`
- `unit`
- `division_hint`
- `confidence`
- `evidence_text`
- `evidence_bbox_json`
- `status`
- `metadata_json`

#### `estimate_extraction_matches`

Stores ranked mappings from extraction rows to catalog items or historical patterns.

Suggested fields:

- `id`
- `extraction_id`
- `catalog_item_id`
- `catalog_code_id`
- `historical_line_item_id`
- `match_type`
- `match_score`
- `status`
- `reason_json`

#### `estimate_pricing_recommendations`

Stores calculated pricing recommendations for matched rows.

Suggested fields:

- `id`
- `project_id`
- `deal_id`
- `extraction_match_id`
- `recommended_quantity`
- `recommended_unit`
- `recommended_unit_price`
- `recommended_total_price`
- `price_basis`
- `catalog_baseline_price`
- `historical_median_price`
- `market_adjustment_percent`
- `confidence`
- `assumptions_json`
- `created_by_run_id`

#### `estimate_generation_runs`

Tracks each end-to-end generation attempt.

Suggested fields:

- `id`
- `project_id`
- `deal_id`
- `triggered_by_user_id`
- `status`
- `started_at`
- `completed_at`
- `input_snapshot_json`
- `output_summary_json`
- `error_summary`

#### `estimate_review_events`

Tracks reviewer decisions and overrides.

Suggested fields:

- `id`
- `project_id`
- `deal_id`
- `subject_type`
- `subject_id`
- `event_type`
- `before_json`
- `after_json`
- `reason`
- `user_id`
- `created_at`

## Why New Catalog Tables Are Required

The CRM needs local catalog tables because the estimating workflow must:

- search catalog items quickly during matching
- join catalog items to historical estimate data
- preserve a stable pricing snapshot for each generated estimate
- work even when Procore is unavailable
- audit what source catalog data was used when a draft estimate was generated

Directly querying Procore at estimate-generation time would be slower, harder to audit, and more brittle.

## Pricing Strategy

The pricing engine should be multi-source and evidence-ranked.

Recommended ranking:

1. matched Procore-synced catalog baseline
2. similar historical estimate line items
3. vendor/sub quotes when available
4. internal labor and production assumptions
5. geographic market-rate adjustment

Each recommendation should expose:

- chosen unit and quantity
- recommended unit price and total
- comparable historical items
- applied adjustments
- confidence
- reviewer-editable assumptions

## Historical Data Strategy

Historical data should not be used as a raw text blob. It should be normalized into pricing signals.

Useful signals include:

- similar historical estimate line items by label, unit, code, and project type
- prior awarded amounts and gross margin outcomes where available
- estimate acceptance or win/loss outcomes
- estimator overrides and revision patterns

This allows the system to answer both generation and copilot questions with structured evidence.

## Market-Rate Strategy

Market-rate information should be treated as a refinement layer, not the primary source of price truth.

Recommended uses:

- adjust labor/material ranges by geography
- flag bids that are materially high or low relative to the region
- support explanation in copilot responses

Phase 1 can begin with simple regional adjustment factors keyed by geography and project type, then grow into more sophisticated sourcing later.

## Copilot Scope

Copilot should be separate from the main estimate-generation pipeline.

Its Phase 1 role is advisory:

- explain why prices were recommended
- answer what similar bids were used
- explain historical win patterns
- identify high-risk or low-confidence areas in the draft estimate
- suggest where an estimator may want to review assumptions

It should not directly mutate estimates without human confirmation.

## Integration With Existing CRM Estimate Model

The CRM already has estimate sections and estimate line items. Phase 1 should reuse those structures for the final editable estimate.

The new pipeline should feed the existing estimate model rather than replace it.

Recommended implementation behavior:

- generated rows first live in review-oriented workflow tables
- estimator approval promotes those rows into the canonical estimate sections and line items
- subsequent edits continue using the existing estimate UI and service layer

## Error Handling

The workflow should make failures visible and recoverable.

Required behaviors:

- catalog sync failures should not block viewing prior synced catalog data
- OCR or extraction failures should mark document/run status clearly
- unmatched extraction rows should surface in review instead of silently dropping
- low-confidence pricing should be flagged, not hidden
- estimate generation should preserve partial outputs when reviewable

## Security And Access

The system will handle bid documents and pricing data, so access should follow existing CRM permissions around projects, estimating, and documents.

Phase 1 should also ensure:

- upload access is permission-checked
- extracted document content is tenant-scoped
- pricing history and copilot answers are tenant-scoped
- Procore sync credentials remain isolated to integration storage

## Phased Delivery

### Phase 1

- one-way Procore catalog sync into local tables
- project document upload in estimating
- OCR and structured extraction
- catalog match review
- historical-data-backed pricing recommendations
- market-rate refinement
- draft estimate generation
- estimator review log

### Phase 2

- richer similarity scoring for historical jobs
- better market-rate sourcing and adjustment rules
- win/loss analytics inside copilot
- recommendation feedback loops from estimator edits

### Phase 3

- plan-aware quantity extraction improvements
- visual takeoff tooling if still desired
- optional export or downstream sync flows

## Success Metrics

The team proposal should evaluate the feature on three dimensions.

### Speed

- time from document upload to first draft estimate
- reduction in manual first-pass estimate preparation time

### Accuracy

- percent of draft rows accepted without major rewrite
- pricing variance between draft estimate and final approved estimate
- reduction in omitted or mismatched catalog items

### Competitive advantage

- number of bids turned around per estimator
- estimator capacity gain during busy bid windows
- improved reuse of proven pricing knowledge across projects

## Testing Strategy

Phase 1 testing should cover:

- Procore sync mapping correctness
- OCR ingestion and extraction record creation
- catalog matching ranking logic
- pricing recommendation calculations
- estimate promotion into existing estimate sections and line items
- permission enforcement and tenant isolation

The architecture should favor deterministic services around extraction normalization, matching, and pricing so core behavior can be tested without relying entirely on end-to-end model calls.

## Recommendation

Build this as an estimating workflow augmentation inside the project estimating tab, not as a separate AI app.

The best first release is:

- uploaded documents in estimating
- OCR extraction into structured scope rows
- automatic mapping to a Procore-synced local catalog
- pricing recommendations from historical data and market-rate adjustments
- draft estimate generation into the existing estimate model
- copilot explanations and advisory insight for estimators

This provides the team a credible path to faster bid turnaround, more consistent pricing, and stronger reuse of historical estimating knowledge without asking them to trust a black-box autonomous system.
