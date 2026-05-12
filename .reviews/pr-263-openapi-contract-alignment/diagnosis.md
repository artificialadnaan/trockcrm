# PR #263 OpenAPI Contract Alignment — Diagnosis

Date: 2026-05-12
Trigger: track brief flagging that PR #263 left mutation routes (POST /api/deals, PATCH /api/deals/{id}, POST /api/deals/{id}/stage) bypassing `redactDealResponse`, causing responses to omit the required `isHubspotSourced` field.

## Outcome

**NO-OP.** The contract gap was already resolved on `main` by follow-up PRs that landed within ~25 minutes of PR #263 itself. No additional code changes are required from this track.

## Evidence

### 1. PR #263 (merged 02:49 UTC) introduced the contract

- `server/src/modules/deals/redact.ts` injects `isHubspotSourced: boolean` on every response.
- `server/src/api-spec.ts` adds `isHubspotSourced` to the `Deal` schema's `required` array (line 92).

### 2. Three follow-up PRs landed before this track was filed

- **PR #265** "fix(deals): server-derived isHubspotSourced flag + gate on it (Codex follow-up to PR #258)" — merged 02:51 UTC.
- **PR #266** "hotfix(deals): add isHubspotSourced to stale test fixtures" — merged 03:02 UTC.
- **PR #267** "docs(deals-fixup): HubSpot source flag — final report + smoke evidence (PRs #263/#265/#266, PASS)" — merged 03:05 UTC.

The fix-up wave (#265) was the actual contract-alignment commit. By the time this track was filed, main was at `5b8777ad` containing all five PRs.

### 3. Static check on `server/src/modules/deals/routes.ts`

Every route that returns an object shaped like the `Deal` schema (i.e. the response body has a `deal: { ... }` key) passes through `redactDealResponse`:

| Route | Method | Line | Redacted? |
|---|---|---|---|
| `GET /api/deals` | list | 355–358 | ✅ via `redactDealList` |
| `GET /api/deals/pipeline` | list | 398–409 | ✅ via `redactDealList` (both columns) |
| `GET /api/deals/:id` | read | 481 | ✅ |
| `GET /api/deals/:id/detail` | read | 494–496 | ✅ |
| `POST /api/deals` | create | 872 | ✅ |
| `PATCH /api/deals/:id/contract-signed-date` | update | 904 | ✅ |
| `POST /api/deals/:id/proposal-draft` | create | 924 | ✅ |
| `PATCH /api/deals/:id` | update | 971 | ✅ |
| `POST /api/deals/:id/stage` | mutate | 1016–1017 | ✅ |

Two endpoints return a narrower shape that does NOT match the `Deal` schema:

| Route | Returns | Why not redacted |
|---|---|---|
| `GET /api/deals/stages/:stageId` | service rows from a hand-written SELECT | The SELECT explicitly enumerates columns and does not include `hubspot_deal_id` (commented at routes.ts:415). Not a `Deal` schema response. |
| `GET /api/deals/nearby` | `{ id, dealNumber, name, propertyCity, distance }` | Explicit projection of 5 fields; not a `Deal` schema response. |

Neither violates the `Deal` schema contract because neither claims to return a `Deal`.

### 4. `redactDealResponse` always injects the source flag

```ts
const isHubspotSourced = deal.hubspotDealId != null;
// every branch below returns { ...x, isHubspotSourced }
```

All three return paths in the function include `isHubspotSourced`. Caller cannot accidentally produce a response that omits it.

### 5. Production smoke (read-only, no mutation)

```
GET https://trockcrm.com/api/deals/<known-hubspot-imported-deal>
→ HTTP 200
→ isHubspotSourced present: True
→ isHubspotSourced value:   True   (correct — this deal is HubSpot-sourced)
→ hubspotDealId present:    False  (correctly redacted for non-admin opt-in)
```

This proves the live deployment honors both contract guarantees: `isHubspotSourced` is always returned, and `hubspotDealId` is only returned with the admin opt-in. The same `redactDealResponse` function is called from every mutation route, so the contract is also honored on mutation responses.

## Why not also smoke a mutation in prod

The brief asks for POST/PATCH/POST-stage smokes. We did not run them because:
- Creating a SMOKE TEST DELETE deal via API would put prod data in flight, and the cleanup step is its own risk surface
- The read smoke above exercises the same `redactDealResponse` code path used by all mutation routes (the function is a pure transformer; the route-specific differences are upstream of it)
- The static check confirms every mutation route passes through that function

A mutation smoke is a reasonable next step but not necessary to close this track.

## Recommendation

Close the track as a no-op. No PR needed.

If a follow-up wants belt-and-suspenders confidence, a single read-only contract test (e.g. Zod or AJV schema validation against the actual response from each Deal-returning endpoint, using fixtures or against a test tenant) would assert the property across all routes mechanically. Tracked as a P3 follow-up — not blocking go-live.
