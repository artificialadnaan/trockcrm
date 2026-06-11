# Mapbox Address Autocomplete — Design Spec

**Date:** 2026-06-11
**Status:** PAPER (design approved; implementation plan next — no code until plan sign-off)
**Depends on:** #673 (property-repair consolidation, merged), #676 (catch-net tests, merged)

## Problem

Property addresses are typed free-hand, producing dirty/inconsistent data (e.g. a prod record mixing "North Haskell Ave" / "west lafayette, IN" / Dallas ZIP 75204). Add **Mapbox-powered address autocomplete**: as the user types a street address, show suggestions; on select, auto-fill street + city + state + ZIP from canonical Mapbox data.

## Scope

### In scope — the editable property-address entry points (exactly TWO, confirmed at sign-off)
1. **Create Property dialog** — `client/src/components/properties/property-create-dialog.tsx` (the `Address` field).
2. **PropertySelector "Complete property" repair editor** — `client/src/components/properties/property-selector.tsx` (the inline repair `address` field).

### Explicitly OUT of scope
- **Property detail page** (`property-detail-page.tsx`) — address is **read-only**; its "Edit" button links to `/properties/:id/edit`, **a route with no component today** (unbuilt). No address input to wire. *Forward note:* if a property-edit page is ever built, it reuses the shared `<AddressAutocomplete>`.
- **Contact address** (`contact-form.tsx`) — a *contact* address, not a property address.
- **Dedup-on-create** — the un-deduped "Add New Property" path (project memory `property-create-dedup-gap`). Design AFTER this lands, against cleaner canonical addresses. NOT part of this PR.

## Decisions (confirmed)

- **Provider:** Mapbox. **Token:** a fresh, URL-restricted `pk.*` stored **server-side** as `MAPBOX_TOKEN` env (Railway); the token shared earlier in chat is rotated/**dead** and must not be referenced.
- **Architecture:** **server proxy** — the browser never sees the token; enables debounce/rate-limit/cache and provider swap.
- **Country restriction:** **US-only, via a named config constant** `ADDRESS_AUTOCOMPLETE_COUNTRY = "us"` (not an inline literal). Documented assumption: *"US-only by config; revisit if non-US properties are onboarded."*
- **Mapbox API:** **Geocoding API v6 forward** — **stateless, per-request. No session tokens, no suggest/retrieve two-step, no session lifecycle.** (See the alternative note below; session-token language applies ONLY to that alternative, never to the v6 path we are building.)
- **Correctness invariant:** selecting a suggestion fills only **4 of 6** required fields (address/city/state/zip — NOT buildYear/unitCount). It still runs through `getMissingPropertyFields(prop, { requireLeadCreate: true })`. **No "selected = complete" shortcut.**

## Architecture

### 1. Server proxy — `GET /api/address/suggest?q=<text>`
- New module `server/src/modules/address/` (routes + service), mounted in `app.ts` as `app.use("/api/address", addressRoutes)` (authed like other CRM routes).
- Reads `MAPBOX_TOKEN` from env. Named constants in the module: `ADDRESS_AUTOCOMPLETE_COUNTRY = "us"`, `MAPBOX_REQUEST_TIMEOUT_MS = 3000`, `SUGGEST_LIMIT = 5`, `MIN_QUERY_LENGTH = 3`.
- Calls **Mapbox Geocoding v6 forward** (stateless): `/search/geocode/v6/forward?q=<q>&autocomplete=true&types=address&country=${ADDRESS_AUTOCOMPLETE_COUNTRY}&limit=${SUGGEST_LIMIT}&access_token=…`, with an `AbortController` timeout of `MAPBOX_REQUEST_TIMEOUT_MS`.
- Maps each feature → trimmed shape (no Mapbox-internal fields leak to the client):
  ```ts
  interface AddressSuggestion { id: string; label: string; address: string; city: string; state: string; zip: string; }
  ```
  street line from the feature address; city/state/zip from the feature `context`/`properties`. Returns `{ suggestions: AddressSuggestion[] }`.

### 2. Shared client component — `<AddressAutocomplete>`
- Location: `client/src/components/properties/address-autocomplete.tsx`.
- Props:
  ```ts
  interface AddressAutocompleteProps {
    value: string;                                   // street-address text (controlled)
    onChange: (address: string) => void;             // free typing always allowed
    onSelect: (parts: { address: string; city: string; state: string; zip: string }) => void;
    officeId?: string | null;
    id?: string; "aria-label"?: string; placeholder?: string; required?: boolean;
  }
  ```
- Named constants: `INPUT_DEBOUNCE_MS = 250`, `MIN_QUERY_LENGTH = 3`. (The **request timeout lives server-side**, `MAPBOX_REQUEST_TIMEOUT_MS = 3000` — a separate number from the 250ms input debounce; the client may also abort an in-flight request when a newer keystroke supersedes it.)
- Behavior: text `<Input>` + suggestion dropdown. Debounced `INPUT_DEBOUNCE_MS`; only queries when `length >= MIN_QUERY_LENGTH`; `GET /api/address/suggest`. Clicking a suggestion fires `onSelect(parts)` and closes the **dropdown** (not the editor — see below). Manual typing always works via `onChange`; suggestions are assistive, never mandatory.

### 3. Degrade contract (precise)
**Triggers** — any of these yields **empty suggestions / no dropdown** for that attempt:
1. `MAPBOX_TOKEN` not set in env (server returns `{ suggestions: [] }`).
2. Non-2xx from Mapbox.
3. Mapbox request timeout (`MAPBOX_REQUEST_TIMEOUT_MS`).
4. Query `< MIN_QUERY_LENGTH` (client makes no request).

**Retry, not latch:** a failed/empty request degrades **only that keystroke's attempt**. The component MUST NOT latch into plain-input mode for the session — the **next keystroke retries** the endpoint normally. (No persistent "disabled" flag set on first failure.) The form is never blocked or 500'd; the field always accepts manual entry.

### 4. Post-select UI state (the invariant, made visually explicit)
On selecting a suggestion in a host that requires lead-create fields (repair editor / create dialog):
- The 4 address fields (street/city/state/zip) fill from `onSelect`.
- The **editor STAYS OPEN.** No auto-close, no green check, no "complete" affordance.
- **Year Built and Number of Units remain visibly present and required**, and the completeness gate (`getMissingPropertyFields(..., { requireLeadCreate: true })`) keeps surfacing them as missing until the user fills them.
- "Save / Complete property" remains gated on all six fields exactly as today. Selecting an address is **not** completion.

### 5. Wiring (host responsibilities)
- **PropertyCreateDialog:** replace the `Address` `<Input>` with `<AddressAutocomplete>`; `onSelect` sets `formData.{address,city,state,zip}` in one update. Year/units stay separate; existing validation (shared `property-completeness`) still gates submit.
- **PropertySelector repair editor:** replace the street `<Input>` with `<AddressAutocomplete>`; `onSelect` populates `repairDraft.{address,city,state,zip}`. Save still runs `getMissingPropertyFields(patch, { requireLeadCreate })` — missing buildYear/unitCount keep the property incomplete.

## Data flow
`type` → debounce 250ms → (len≥3) `GET /api/address/suggest?q=` → server → Mapbox v6 (3s timeout) → trimmed suggestions → dropdown → select → `onSelect({address,city,state,zip})` → host fills 4 fields → completeness gate still runs → buildYear/unitCount remain user-entered, editor open.

## Alternative considered (NOT chosen)
**Mapbox Search Box API** (`/search/searchbox/v1/suggest` + `/retrieve`) — session-token-based, two-step, cheaper for high-volume typeahead but adds **session-token lifecycle** complexity. We are NOT using it; the v6 path has no session tokens. The server-proxy boundary lets us swap to it later without touching the client. (This is the only place session-token language appears — it does not apply to the chosen v6 path.)

## Testing
- **Server:** unit-test the Mapbox-feature → `AddressSuggestion` parser (incl. partial `context`); degrade mapping for each trigger (no token / non-2xx / timeout → `{ suggestions: [] }`). Mock fetch — no live Mapbox.
- **Client:** `<AddressAutocomplete>` — debounce fires one request; `<3` chars makes no request; select calls `onSelect` with parsed parts; error/empty → no dropdown AND next keystroke retries (no latch). 
- **Invariant test:** in the repair-editor host, selecting a suggestion fills the 4 fields, the editor stays open, and the completeness gate still reports buildYear/unitCount missing (no "selected = complete").

## Out-of-scope follow-ups (tracked, not built here)
- **Dedup-on-create** (`property-create-dedup-gap`) — design after this merges; recommend shape then (near-match warning vs unique constraint vs both) against canonical post-Mapbox data.
- **Haskell duplicate** cleanup (`data-cleanup-haskell-duplicate`) — human merge decision, not code.

## Rollout / discipline
- Branch off **current `main`** (post-#673/#676). **Re-confirm disjoint surfaces immediately before the branch goes up** — main has moved since the last check; verify no live lane touches `property-selector.tsx`, `property-create-dialog.tsx`, or the new `server/src/modules/address/`.
- Gated merge: `@codex` + `@coderabbitai` green on the exact tip, then `gh pr merge {N} --merge`.
