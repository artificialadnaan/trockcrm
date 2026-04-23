# Estimating Document Parsing Design

**Date:** 2026-04-20  
**Owner:** Codex  
**Status:** Draft for review

## Goal

Replace the placeholder estimating OCR path with a real document parsing pipeline that:

- supports PDFs and image uploads
- uses provider-agnostic adapters instead of binding the feature to one model vendor
- extracts structured scope candidates from plans and specs
- auto-detects sheet scale and produces suggested measurement candidates
- requires estimator confirmation before measurement-derived quantities influence pricing
- supports estimator-triggered re-run parsing from the estimating workbench

## Scope

This slice upgrades the document parsing layer only. It does not redesign pricing, historical bid matching, or the rest of estimate generation beyond consuming better extraction output.

Included:

- file normalization for PDFs and image files
- page-level OCR/text extraction
- sheet classification metadata
- scale detection and measurement candidate generation
- structured extraction rows for scope lines and measurement candidates
- estimator-triggered re-run parsing with provider/options selection
- document-level supersession so stale parse artifacts are replaced cleanly

Not included:

- full CAD-style drawing tools
- autonomous pricing approval
- vendor-specific architecture
- production market-rate enrichment

## Product Outcome

An estimator uploads plans or image sheets into the estimating tab, runs parsing, and gets a reviewable workbench populated with:

- parsed document pages
- scope-line extraction suggestions
- measurement suggestions tied to detected scale
- confidence and evidence for every suggestion
- clear failure states when some parts of parsing succeed and others do not

The result is a more trustworthy input layer for matching, pricing, and estimate drafting.

## Design Principles

### 1. Parsing is a pipeline, not one provider call

The system should separate:

- page normalization
- OCR/text extraction
- layout or sheet interpretation
- scale detection
- scope extraction
- measurement extraction

This keeps failures diagnosable and lets the team improve one stage without rewriting the whole flow.

### 2. Provider-agnostic interfaces are mandatory

The CRM should not assume Anthropic, OpenAI, or any single OCR engine is permanent. Parsing adapters must sit behind stable interfaces so the worker orchestration and database contracts stay constant while providers change.

### 3. Measurement suggestions are advisory until confirmed

Scale and measurement detection are useful but error-prone. The system may auto-detect them and propose values, but estimators must confirm them before those quantities can influence downstream pricing or promotion.

### 4. Re-runs supersede active parse artifacts

Reprocessing a document should not leave multiple active page and extraction sets competing in the workbench. The newest successful parse becomes the active parse output for that document, while review history remains preserved at the event or run layer.

## Existing System Context

Today the worker path in [worker/src/jobs/estimate-document-ocr.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/estimating-ai-bid-drafts/worker/src/jobs/estimate-document-ocr.ts) does not parse uploaded files. It:

- loads the document record
- synthesizes a single fake page using filename and document type
- inserts one placeholder page row
- line-splits that synthetic text through [server/src/modules/estimating/extraction-service.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/estimating-ai-bid-drafts/server/src/modules/estimating/extraction-service.ts)
- stores placeholder scope-line extractions

That path is acceptable for schema bootstrapping but not for real estimating workflows.

The current schema already gives a strong starting point:

- [shared/src/schema/tenant/estimate-source-documents.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/estimating-ai-bid-drafts/shared/src/schema/tenant/estimate-source-documents.ts)
- [shared/src/schema/tenant/estimate-extractions.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/estimating-ai-bid-drafts/shared/src/schema/tenant/estimate-extractions.ts)

The design should extend those records with richer metadata and active-parse semantics rather than creating a parallel storage model unless a concrete schema gap requires it.

## Recommended Approach

Use a normalized parsing pipeline with hybrid deterministic and provider-assisted steps.

Recommended breakdown:

- deterministic normalization handles PDF pages, standalone images, and page image generation
- OCR adapters extract visible text and basic layout signals
- deterministic heuristics extract obvious dimensions, scale labels, and scope-table patterns where possible
- provider adapters resolve higher-ambiguity classification, scope structuring, and measurement interpretation

This produces better explainability than a single black-box provider call while still allowing model assistance where plans are messy.

## Architecture

### Main Components

#### `DocumentParseOrchestrator`

Coordinates the end-to-end parse lifecycle for one estimating document.

Responsibilities:

- load the source document and validate the parse request
- normalize the file into one or more page inputs
- invoke OCR and classification adapters
- invoke scale detection and measurement extraction
- create structured extraction rows
- mark parse status and supersede prior active outputs
- queue downstream estimate generation once parsing succeeds enough to produce actionable rows

#### `DocumentPageExtractor`

Normalizes source files into page-shaped inputs.

Responsibilities:

- detect whether the source file is a PDF or image
- split PDFs into pages
- normalize images into a page representation
- produce page image artifacts or references usable by OCR and measurement stages
- return consistent page descriptors for downstream stages

Supported `V1` sources:

- PDF
- PNG
- JPG / JPEG
- TIFF only when the existing normalization stack can decode it through the same image path; otherwise `V1` should reject it explicitly instead of silently accepting it

#### `DocumentOcrAdapter`

Extracts raw text and basic layout signals from normalized pages.

Responsibilities:

- run OCR per page
- return text blocks, line text, and provider metadata
- preserve page-level evidence such as bounding regions when available

#### `SheetClassificationProvider`

Assigns page-level sheet metadata.

Responsibilities:

- infer sheet label if available
- classify page type such as plan, elevation, detail, schedule, spec, cover, or unknown
- record confidence and rationale metadata

#### `ScaleDetectionProvider`

Detects scale declarations and measurement context.

Responsibilities:

- identify candidate scale text on the page
- infer normalized scale form when possible
- surface confidence and evidence
- mark when scale detection is unavailable or ambiguous

#### `EstimateExtractionProvider`

Produces structured estimating rows from page content.

Responsibilities:

- extract `scope_line` candidates from OCR text, schedules, and table-like patterns
- extract `measurement_candidate` rows from dimensions or inferred measured features
- return normalized label, quantity, unit, division hints, and evidence
- mark provider and method metadata for each row

### Data Flow

1. Estimator uploads a document in the estimating tab.
2. The document enters the parse queue in `queued` state.
3. The worker resolves the office schema and loads the source document.
4. `DocumentPageExtractor` turns the file into normalized pages.
5. `DocumentOcrAdapter` extracts text and page evidence.
6. `SheetClassificationProvider` and `ScaleDetectionProvider` enrich each page.
7. `EstimateExtractionProvider` emits structured extraction candidates.
8. The orchestrator supersedes prior active page and extraction artifacts for the document.
9. The document is marked parsed, with success or partial-success metadata.
10. Downstream generation continues using the active extraction set.

## Parsing Profiles and Re-Run Controls

The estimating workbench should expose `Re-run Parsing` as a deliberate document action.

`V1` re-run controls should include:

- parsing provider selection from the configured adapter list
- parsing profile selection such as `balanced`, `text-heavy`, or `measurement-heavy`
- optional flags for enabling or disabling measurement detection

The UI does not need a complex configuration wizard. It needs a compact control that lets an estimator intentionally rerun a document when the first pass was weak or optimized for the wrong document type.

The route contract should accept explicit parse options so the system is not forced into a single hidden default.

## Storage Model

### Reuse Existing Tables

Keep the current estimating document and extraction tables as the system of record:

- `estimate_source_documents`
- `estimate_document_pages`
- `estimate_extractions`

Add one new parse-run table for rerun history and active-run control:

- `estimate_document_parse_runs`

### Extend Metadata Instead of Forking Schema

`estimate_source_documents` should store parse lifecycle metadata in addition to the current OCR status:

- active parse run identifier
- parse status that can distinguish `queued`, `processing`, `completed`, `partial`, `failed`
- last parse provider/profile summary
- parse error summary when the latest run fails

`estimate_document_parse_runs` should store:

- document id
- parse status
- provider identifier
- parse profile
- options snapshot json
- stage summary json
- error summary
- started at and completed at timestamps
- whether the run became the active parse for the document

This makes rerun history explicit and gives the workbench and worker a stable way to reason about supersession without overloading document metadata alone.

`estimate_document_pages.metadata_json` should store:

- source kind: `pdf_page` or `image`
- source parse run id
- OCR provider and method
- classification result and confidence
- scale detection result, normalized scale, and confidence
- image or rendering metadata such as dimensions and resolution
- whether the page belongs to the currently active parse output

`estimate_extractions` should continue to store structured rows, but `metadata_json` should clearly distinguish:

- extraction provider and method
- source parse run id
- whether the row is measurement-derived
- measurement confirmation state
- scale evidence and normalized scale
- structured evidence references for page blocks or bounding boxes

### Extraction Types

`V1` should explicitly support at least:

- `scope_line`
- `measurement_candidate`

`measurement_candidate` rows should carry enough metadata to tell whether they are safe to use:

- detected quantity
- normalized unit
- detected scale
- confidence
- `requiresEstimatorConfirmation: true`
- confirmation status

## Active Parse and Supersession Rules

Each successful re-run should supersede prior active parse artifacts for the same document.

Rules:

- only one parse result set is active per document at a time
- new successful page rows and extraction rows become active
- prior rows remain in the database for auditability and are explicitly marked inactive through parse-run metadata
- review history remains preserved through review events and parse-run metadata
- failed reruns must not destroy the previously active successful parse output
- workbench queries, matching, pricing, and generation only read rows associated with the document's active parse run unless a screen explicitly requests historical parse output

This means supersession occurs only after the new parse has produced a valid replacement set. A failed rerun leaves the previous active parse visible in the workbench.

## Estimator Confirmation Rules

Measurement-derived suggestions must not silently feed pricing.

Rules:

- scale detection is automatic
- measurement candidates are automatic
- both are advisory until estimator confirmation
- estimator confirmation should be represented on the extraction row metadata so the existing extraction review flow can confirm or reject a measurement suggestion without introducing a separate confirmation subsystem in `V1`
- confirmed measurement rows may continue into matching and pricing
- unconfirmed measurement rows remain visible in the workbench but are excluded from promotion-ready pricing flows

Plain `scope_line` rows may continue through the existing review path as they do today.

## Failure Model

Parsing failures should be document-scoped and stage-specific.

Supported outcomes:

- `completed`: OCR and extraction succeeded enough to produce active outputs
- `partial`: some stages failed, but useful outputs still exist
- `failed`: no useful parse output was produced

Examples:

- OCR succeeds, scale detection fails: status `partial`, scope rows visible, measurement unavailable
- page extraction fails on a corrupt PDF: status `failed`
- one page of a PDF fails but others succeed: status `partial`

The UI should surface the failing stage so estimators know whether to rerun with a different provider/profile or replace the document.

## Worker and Service Boundaries

### Server Modules

Expected new or revised services:

- `server/src/modules/estimating/document-parse-orchestrator.ts`
- `server/src/modules/estimating/document-page-extractor.ts`
- `server/src/modules/estimating/ocr-adapters/*`
- `server/src/modules/estimating/extraction-providers/*`
- `server/src/modules/estimating/scale-detection/*`

`server/src/modules/estimating/extraction-service.ts` should stop being a placeholder line splitter and become a normalization layer over structured parser outputs.

### Worker Job

[worker/src/jobs/estimate-document-ocr.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/estimating-ai-bid-drafts/worker/src/jobs/estimate-document-ocr.ts) should be upgraded from a placeholder OCR job into the real parsing entrypoint. The job name can stay the same for now if that reduces migration risk, but its implementation should become a document parsing orchestration path rather than “OCR only.”

The job should:

- load the parse options from the re-run request or document defaults
- invoke the parse orchestrator
- update document parse status safely
- preserve the previous active parse when a rerun fails
- only queue estimate generation when actionable active extractions exist

## API Changes

### Re-Run Endpoint

The existing document reprocess route should evolve into a parsing rerun endpoint that accepts options.

Suggested request shape:

```json
{
  "provider": "default",
  "profile": "balanced",
  "enableMeasurementDetection": true
}
```

The response should return:

- updated document status
- selected parse options
- whether the previous parse remains active while rerun is pending

### Workflow State Payload

The workbench document payload should expose:

- parse status
- active parse provider/profile summary
- partial failure warnings
- page counts
- count of confirmed vs unconfirmed measurement candidates

The extraction rows payload should expose whether a row is measurement-derived and whether estimator confirmation is required or already complete.

For `V1`, measurement confirmation should reuse the existing extraction mutation path:

- approving a `measurement_candidate` row confirms it for downstream pricing use
- rejecting it excludes it from downstream pricing use
- editing it allows an estimator to correct the quantity, unit, or scale metadata before approval

## Testing Strategy

### Server and Worker Tests

Required coverage:

- PDF normalization into page descriptors
- image normalization into page descriptors
- adapter wiring through provider-agnostic interfaces
- successful parse replacing placeholder artifacts with structured outputs
- partial failure preserving usable outputs
- failed rerun preserving the previous active parse
- rerun supersession replacing active outputs without duplicating review rows
- measurement candidates marked as requiring estimator confirmation
- downstream generation excluding unconfirmed measurement candidates

### Route Tests

Required coverage:

- rerun parsing route accepts options and enqueues parsing
- deal access and tenant isolation still hold
- workflow-state route exposes measurement confirmation flags and parse warnings

### Client Tests

Required coverage:

- documents panel surfaces parse status and rerun actions
- rerun controls submit provider/profile settings
- workbench rows show measurement confirmation state clearly
- partial failures do not hide successfully parsed rows

## Rollout

Recommended order:

1. introduce parse-run metadata and active-output semantics
2. build deterministic page normalization for PDF and images
3. introduce provider interfaces and a default adapter implementation
4. replace placeholder extraction path with structured parse outputs
5. add rerun parsing options to the workbench
6. enforce measurement confirmation before pricing consumption

## Risks and Constraints

- scale detection quality will vary significantly by document quality and scan fidelity
- provider output structure may drift, so adapters need strict normalization boundaries
- rerun supersession is easy to get wrong and can create duplicate active rows if not explicitly modeled
- image and PDF rendering can increase worker cost, so page normalization should be bounded and observable

## Success Criteria

This slice is successful when:

- uploaded PDFs and images generate real page records and structured extraction rows
- parsing no longer depends on filename-seeded placeholder text
- estimators can rerun parsing with explicit options from the workbench
- measurement candidates are surfaced with auto-detected scale suggestions
- measurement-derived quantities do not influence pricing until estimator confirmation
- reruns supersede active parse outputs safely without losing the last good parse on failure
