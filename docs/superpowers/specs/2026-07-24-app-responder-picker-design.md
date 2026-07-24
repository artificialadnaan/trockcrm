# App Superintendent/PM Roster Picker — Design

**Date:** 2026-07-24
**Goal:** Replace T-Rock Cam's free-text superintendent/PM entry on QC scorecards with a searchable dropdown sourced from the CRM `field_responders` roster, so the CRM and app show the same list of field users. Depends on the roster from PR #950 (`feat/field-responders-roster`).

## Decisions (confirmed with product)
- **Source:** the full active roster (not deal-scoped assignment).
- **Off-roster people:** allow a typed custom name (free-text fallback) so a field user is never blocked.
- **Storage:** name only — no schema/migration, no `responder_id` linkage. The dropdown just changes *how* the existing `superintendentName`/`pmName` strings are entered.

## Architecture
Storing name-only + free-text fallback means nothing changes in the scorecard schema, submission parsing, corrective-action recipient resolution (`deal_team_members`), or the QC report. The change is two parts: expose the roster to the app, and turn the two text inputs into a searchable picker that writes the same strings as today.

## Server — one new field-accessible endpoint
- `GET /api/field/projects/:dealId/responders` → `{ responders: [{ id, name, email, role }] }`, active only.
- Mirrors the existing `GET /field/projects/:dealId/team`: `requireFieldContractor`, `withResolvedOffice("deal", dealId)` + `assertActiveFieldProject` (returns *that deal's office* roster, cross-office-correct, and inherits the browse-permission gate), then calls the existing `listFieldResponders(officeDb, { includeInactive: false })` and maps to the lean `{ id, name, email, role }` shape.
- Deal-scoped (not a global `/field/responders`) so the app shows the same roster the CRM would for that deal.
- No `route-access-policy` change (already under `/api/field`).

## Mobile — a `ResponderPicker` component
- Replaces the `TextInput` for Superintendent and PM in **both** the regular (`scorecards/[draftId].tsx` `OverviewStep`) and leadership (`scorecards/leadership/[draftId].tsx`) flows.
- A searchable list of active roster members **filtered to the field's role** (superintendent field → `role: superintendent`; PM field → `project_manager`). Selecting one sets the name via the existing `setHeader` action; storage is unchanged.
- A "type a name instead" affordance keeps free-text entry.
- New API method `getFieldResponders(dealId)` (`mobile/src/api/endpoints.ts`) + `FieldResponderOption`/`FieldRespondersResponse` types. Fetched once per scorecard (has `dealId`), shared by both pickers via a small hook.

## Error handling / offline
- If the roster can't load (offline or error), the picker **degrades to the plain text input** — the field user can always type. (No offline cache in v1; the text fallback covers it.)

## Non-goals / compatibility
- No schema/migration, no `responder_id`, no change to corrective-action recipients or the QC filter.
- Existing scorecards keep their text names; new ones get roster-consistent names.

## Testing
- Server runtime test: the endpoint returns active-only, deal-office-scoped responders and is browse-gated.
- Mobile unit tests for `ResponderPicker`: select-from-roster sets the name, typed fallback sets a custom name, degrade-to-text on load error.
