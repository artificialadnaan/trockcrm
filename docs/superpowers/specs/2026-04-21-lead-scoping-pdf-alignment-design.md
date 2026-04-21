# Lead Scoping PDF Alignment Design

**Date:** 2026-04-21  
**Status:** Draft for review  
**Scope:** Full digital mapping of `Project Scoping Checklist COMPLETED.pdf` into the lead workflow, mandatory completion before `Lead Go/No-Go`, and read-only artifact carry-forward onto the successor deal

## Goal

Convert the full `Project Scoping Checklist COMPLETED.pdf` into a first-class in-app `Lead Scoping` workflow that:

- maps every field from the PDF into structured application data
- requires completion before a lead can enter `Lead Go/No-Go`
- supports `N/A` as a valid completion state for every question
- remains distinct from downstream `Deal Scoping`
- produces a read-only artifact that is attached to the converted deal in the `Files` tab

This change must not collapse lead scoping into deal scoping. The lead checklist is the intake and qualification document. The deal scoping workspace remains a separate downstream operational form.

## Confirmed Decisions

- `Lead scoping` and `Deal scoping` are different workflows.
- The full PDF checklist is required for every lead before `Lead Go/No-Go`.
- Every checklist question gets an `N/A` answer choice.
- `N/A` counts as complete for gate validation.
- On conversion, the completed lead-scoping checklist is preserved as a read-only artifact on the successor deal.
- That read-only artifact should appear in the deal `Files` tab.
- Deal scoping remains separate and should only inherit selected useful values, not the full lead checklist as an editable form.

## Current-State Gaps

The current workflow alignment implementation does not satisfy this requirement.

### 1. Lead scoping is only a partial subset

The current lead qualification model stores:

- base qualification fields
- estimated opportunity value
- go decision
- a `scopingSubsetData` object

That subset is intentionally small and does not represent the full PDF.

### 2. Lead gate is too shallow

The current `Lead Go/No-Go` path only requires:

- base qualification
- estimated opportunity value
- a limited scoping subset

It does not require the full checklist.

### 3. Deal scoping currently carries too much of the scoping responsibility

The existing deal scoping workspace is currently the richer structured intake surface. That is backwards for the new operating rule, because the lead must now carry the full scoping PDF before go/no-go.

### 4. No PDF-derived artifact is created on conversion

Lead conversion currently creates the successor deal and links lineage, but it does not generate or attach a read-only lead scoping artifact to the deal.

## Canonical Model

### Lead-side model

Add a dedicated `Lead Scoping` record owned by the lead lifecycle.

This should be a separate schema from `deal_scoping_intake`, for example:

- `lead_scoping_intake`

Each lead has at most one active lead-scoping record.

The record stores:

- structured section data
- per-field completion state
- readiness / validation errors
- created / updated audit fields
- completion timestamps

### Deal-side model

The current `deal_scoping_intake` remains a separate schema and workflow.

It should continue to support:

- opportunity review
- downstream deal scoping
- operational attachments and activation logic

This design does not replace the deal scoping workspace with the lead PDF.

### Conversion model

When a lead converts:

- the lead-scoping payload remains immutable on the lead
- a read-only rendered artifact of the completed lead-scoping checklist is generated
- that artifact is attached to the successor deal as a file
- selected mapped values may seed the deal scoping workspace where useful

The lead-scoping artifact is not editable from the deal.

## Full PDF Field Map

The digital lead-scoping model must cover all sections below.

### 1. Project Overview

Fields:

- property name
- property address
- city / state
- client
- account rep
- date of walk
- bid due date
- project type
  - interior unit renovation
  - exterior renovation
  - amenity / clubhouse renovation
  - DD
  - other
- project type other text

### 2. Budget and Bid Info

Fields:

- owner budget range
- number of bidders
- decision maker
- decision timeline
- client bid portal required
- client bid portal login / format notes
- important context / expectations / upsell / allowances / walkthrough concerns / notes
- pricing mode
  - budget pricing
  - detailed bid
  - alternate pricing

### 3. Property Details

Fields:

- year built
- total units
- total buildings
- floors per building
- unit mix rows
  - bedroom count
  - bathroom count
  - units
  - square footage
- average unit size

### 4. Project Scope Summary

Fields:

- high-level scope summary narrative

### 5. Interior Unit Renovation Scope

Fields:

- units renovated monthly
- renovation type
  - full renovations
  - partial renovations
  - move-in ready

Living room / dining checklist:

- lighting
- electrical devices
- window treatment
- door hardware
- drywall repairs

Kitchen checklist:

- bar cut down
- cabinet replacement
- cabinet refinish
- new countertops
- backsplash
- sink / faucet
- appliance package
- cabinet hardware
- door hardware
- drywall repairs
- notes

Bedrooms checklist:

- lighting
- electrical devices
- window treatment
- door hardware
- drywall repairs
- notes

Bathrooms checklist:

- tub / shower replacement
- tile / surround replacement
- tub / shower resurface
- vanity replacement
- plumbing fixtures
- lighting
- bath accessories / mirrors
- drywall repairs
- notes

Flooring:

- existing flooring
- new flooring
- approximate square footage per unit

Paint:

- full unit paint
- walls only
- trim and doors
- color selections known
- drywall finish
  - textured
  - smooth
  - popcorn

### 6. Exterior Scope

Fields:

- exterior paint
- siding repair / replacement
- stucco repair
- balcony repairs
- railing replacement
- window replacement
- breezeway improvements
- stair repairs
- roof repairs
- accessibility method
  - lift
  - scaffolding
  - swing stage
  - ladder
- notes

### 7. Amenities / Site Improvements

Fields:

- clubhouse renovation
- leasing office upgrades
- pool area improvements
- fitness center
- dog park
- outdoor kitchens
- landscaping
- parking lot repairs
- site lighting
- notes

### 8. Quantities

Fields:

- units renovated
- buildings impacted
- balconies
- staircases
- windows if replacing
- doors
- exterior paintable area estimate

### 9. Site Logistics

Fields:

- staging and dumpster accessibility
- elevator access

### 10. Site Conditions Observed

Fields:

- asbestos
- water damage
- wood rot
- structural concerns
- mold / mildew
- electrical issues
- plumbing issues
- code concerns
- notes

### 11. Materials / Specifications

Fields:

- spec package provided
- finish level
  - budget
  - mid-level
  - premium
- owner supplied materials
- preferred brands

### 12. Attachments Provided

Fields:

- company cam photos
- typical unit photos
- exterior building photos
- amenity photos
- plans / drawings
- finish schedules
- scope documents
- file location note

## Answer Model

### `N/A` requirement

Every question must support `N/A`.

Implementation rule by field type:

- text / number / date fields:
  - store a paired applicability state: `provided` or `na`
- boolean / checkbox / yes-no fields:
  - store tri-state or enum values such as `yes`, `no`, `na`
- single-choice categorical fields:
  - add `na` to the enum
- multi-select / checklist groups:
  - each item supports `yes`, `no`, `na`

This is required because completeness must not depend on forcing fake positive answers for non-applicable scope.

## Lead Gate Rules

### Stage progression change

A lead cannot move into `Lead Go/No-Go` until the full lead-scoping checklist is complete.

Completion means:

- every required PDF field has either a real value or an explicit `N/A`
- every checklist / yes-no / scope item has a chosen state, including `N/A`
- required attachment-presence fields have been answered, even if the answer is `N/A`

This replaces the current smaller `scopingSubsetData` gate for this transition.

### Existing lead stages

The lead stage order remains:

1. `New`
2. `Company Pre-Qualified`
3. `Scoping In Progress`
4. `Pre-Qual Value Assigned`
5. `Lead Go/No-Go`
6. `Qualified for Opportunity`
7. `Disqualified`

The gating change is:

- `Scoping In Progress -> Pre-Qual Value Assigned` may remain based on partial intake progress
- `Pre-Qual Value Assigned -> Lead Go/No-Go` requires the full lead-scoping checklist

## UI Design

### Lead detail

Add a dedicated `Lead Scoping` workspace to the lead detail surface.

This workspace should:

- render all PDF sections in-app
- make applicability explicit with `N/A`
- show completion progress by section
- show blocking fields before `Lead Go/No-Go`
- support autosave

### Data entry UX

The checklist should not try to visually mimic the PDF line-for-line. It should be:

- structured by section
- dense but readable
- optimized for quick intake
- explicit about `N/A`
- auditable

Recommended UX:

- section cards or accordion groups
- grouped checklists for scope areas
- compact tri-state controls for yes / no / n/a
- repeatable rows for unit mix
- section progress badges

### Deal file artifact

After conversion, the deal `Files` tab should include a read-only file such as:

- `Lead Scoping Checklist - <lead/deal name>.pdf`

The file should be:

- generated from the saved structured lead-scoping data
- stored as a normal deal file
- clearly marked as derived from lead conversion

## Carry-Forward Rules

Selected lead-scoping values may seed downstream deal scoping.

Recommended carry-forward fields:

- property / location summary
- bid due date
- project type
- high-level scope summary
- quantities summary
- selected attachments metadata

The downstream deal scoping workspace remains editable and independent.

The lead-scoping artifact on the deal remains read-only.

## Data Model Changes

### New schema

Add a lead-scoping schema, likely:

- `lead_scoping_intake`

Suggested columns:

- `id`
- `lead_id`
- `office_id`
- `status`
- `section_data`
- `completion_state`
- `readiness_errors`
- `first_ready_at`
- `completed_at`
- `last_autosaved_at`
- `created_by`
- `last_edited_by`
- `created_at`
- `updated_at`

### Workflow gate metadata

Update lead workflow gate metadata to reference the new lead-scoping completion contract instead of the smaller current subset.

### Conversion support

Add conversion-time generation and file attachment support for the lead-scoping artifact.

## Testing Requirements

Implementation must include:

- lead-scoping field-model tests
- lead gate validation tests covering `N/A`
- UI tests for the lead-scoping workspace
- conversion tests proving artifact generation / attachment
- regression tests proving deal scoping remains separate

## Risks

### 1. Overwriting the deal scoping model

Risk:

- developers may accidentally reuse `deal_scoping_intake`

Mitigation:

- separate schema, separate service, separate UI component, separate route namespace

### 2. Ambiguous `N/A` semantics

Risk:

- inconsistent handling across field types

Mitigation:

- standardize applicability encoding rules and centralize completion evaluation

### 3. Unstructured artifact generation

Risk:

- generated PDF could drift from stored lead data

Mitigation:

- generate artifact directly from structured lead-scoping data at conversion time
- keep file generation deterministic and testable

## Recommended Implementation Order

1. Add dedicated lead-scoping schema and shared type definitions
2. Add lead-scoping service, routes, and completion evaluator
3. Replace the current partial lead scoping subset gate for `Lead Go/No-Go`
4. Build the lead-scoping UI with full PDF field coverage and `N/A`
5. Add conversion-time artifact generation and file attachment
6. Add selective carry-forward into downstream deal scoping
7. Add automated tests

## Out of Scope

This change does not:

- replace deal scoping with the lead PDF
- make the generated lead-scoping artifact editable from the deal
- redesign downstream deal scoping to mirror the lead PDF
- require a pixel-perfect PDF-like UI inside the app
