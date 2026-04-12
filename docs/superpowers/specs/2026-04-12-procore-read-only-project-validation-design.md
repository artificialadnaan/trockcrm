# Procore Read-Only Project Validation Design

## Goal

Validate the CRM's live Procore connection against the T Rock Procore company and surface project matching/conflict signals without writing anything to Procore and without persisting imported Procore data into CRM tables during the first pass.

This phase is intentionally limited to Procore projects only.

## Scope

In scope:
- Authenticate to Procore with the configured production credentials
- Read project data from the configured `PROCORE_COMPANY_ID`
- Normalize project fields into a stable read-only response shape
- Compare fetched Procore projects against existing CRM deals
- Surface `matched`, `unmatched`, and `ambiguous` comparison results in the admin Procore page
- Add guardrails so this validation pass cannot patch Procore or mutate CRM sync state

Out of scope:
- Contact import
- Change orders
- Webhook processing changes
- Persisting imported Procore rows to CRM tables
- Auto-linking deals to Procore projects
- Creating or updating Procore projects
- Resolving conflicts back into Procore or the CRM

## Current Codebase Constraints

- The existing Procore client in `server/src/lib/procore-client.ts` already supports authenticated GET/POST/PATCH/DELETE calls and a paginated `listCompanyProjectsPage(...)` helper.
- The existing reconciliation service in `server/src/modules/procore/reconciliation-service.ts` already contains useful normalization and project-to-deal comparison logic.
- The current admin Procore routes include write-capable conflict resolution in `POST /api/procore/sync-conflicts/:id/resolve`.
- The current Procore admin page focuses on sync-state tables, not on raw read-only project intake.

These existing pieces should be reused where they help, but the first validation pass must remain explicitly read-only.

## Proposed Approach

### 1. Read-Only Server Endpoint

Add a new admin-only route under `/api/procore` that:
- fetches live Procore projects for the configured company
- uses paginated reads only
- returns normalized projects plus CRM comparison results
- does not write to:
  - `public.procore_sync_state`
  - reconciliation state tables
  - tenant `deals`
  - Procore APIs using `POST`, `PATCH`, or `DELETE`

Recommended route:
- `GET /api/procore/project-validation`

Response shape:
- `projects`: normalized Procore rows with comparison status
- `summary`: counts for matched, unmatched, ambiguous
- `meta`: company id, fetched count, fetched at timestamp, read-only mode flag

### 2. Comparison Logic

Reuse the normalization and scoring patterns already present in `reconciliation-service.ts`, but keep the first pass non-persistent.

Matching priority:
1. Existing `deals.procore_project_id` exact match
2. Exact project number to `deals.deal_number`
3. Strong normalized name + location match
4. Otherwise mark as unmatched

If multiple CRM deals score similarly for one Procore project, mark the row as `ambiguous` instead of guessing.

Comparison statuses:
- `matched`
- `unmatched`
- `ambiguous`

Per-row output should include:
- Procore project id
- project name
- project number
- city/state/address
- updated timestamp
- matched CRM deal id/name/number when present
- match reason
- discrepancy summary for key fields

### 3. Frontend Review Surface

Extend the admin Procore page to support a read-only validation mode.

The page should show:
- a top-level banner indicating `Read-only validation mode`
- a refresh action that triggers the live fetch
- summary counts
- a table of normalized Procore projects and CRM comparison status
- clear visual distinction for:
  - matched
  - unmatched
  - ambiguous

Do not show actions that imply mutation during this phase.

The existing conflict resolution controls should either remain hidden in read-only validation mode or be visually separated as not part of this first pass.

## Write-Safety Guardrails

This phase must not write into Procore.

Guardrails:
- The new validation route may only call `procoreClient.get(...)` or paginated list helpers built on GET
- Do not call:
  - `procoreClient.post(...)`
  - `procoreClient.patch(...)`
  - `procoreClient.delete(...)`
- Do not reuse the existing conflict-resolution route in this workflow
- Do not update `deals.procore_project_id`
- Do not insert/update sync-state or reconciliation-state rows

Implementation should make the read-only nature obvious in code structure, not just by convention.

## Error Handling

Return explicit admin-visible states for:
- missing `PROCORE_CLIENT_ID`
- missing `PROCORE_CLIENT_SECRET`
- missing `PROCORE_COMPANY_ID`
- Procore auth failure
- Procore rate limiting
- Procore circuit breaker open
- unexpected upstream response shape

Frontend behavior:
- show a clear error state instead of a silent empty table
- preserve the last successful result in UI state only if the next fetch fails

## Testing

Server tests:
- project validation route returns normalized read-only rows
- exact linked matches are labeled `matched`
- multiple strong candidates are labeled `ambiguous`
- no candidate is labeled `unmatched`
- route remains admin-only
- route does not invoke write-capable Procore client methods

Frontend tests:
- summary renders correctly
- status badges/tables render for matched/unmatched/ambiguous
- fetch failure shows an explicit error message

Manual verification:
- use the admin Procore page
- confirm live projects are visible
- confirm no Procore write endpoints are called during the validation fetch

## Success Criteria

This phase is successful when:
- the CRM can fetch live Procore projects from company `598134325683880`
- the admin can review those projects in the CRM
- projects are classified as matched, unmatched, or ambiguous against CRM deals
- no data is written back to Procore
- no CRM sync-state or deal-link tables are mutated by the validation fetch

## Implementation Notes

- Prefer reusing reconciliation normalization helpers instead of duplicating fuzzy matching logic.
- Keep the new read-only flow isolated from the existing sync/conflict-resolution flow so future write-enabled sync can be introduced deliberately rather than accidentally inherited.
- Any future persistence phase should be a separate spec and plan after this read-only inspection pass is validated.
