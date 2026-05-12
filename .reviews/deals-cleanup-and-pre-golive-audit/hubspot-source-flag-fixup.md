# Fix-up: HubSpot source flag (Codex follow-up to PR #258)

## Status

**PASS** — merged as `7c80483` via PR #265.

## Background

PR #258 (deals-cleanup-and-pre-golive-audit) redacted `hubspotDealId` from `/api/deals/:id/detail` but introduced a regression Codex caught on round 1: `DealDetailPage`'s Bid Board summary panel gate was `!deal.hubspotDealId`, so after the field was redacted every HubSpot-sourced deal looked native to the client and the panel rendered for it.

The original PR's round-1 fix-up commit (`e16ca67`) used a brittle client-side workaround — `isHubspotImportedDealNumber(deal.dealNumber)` — which sniffs the `HS-*` prefix on the deal number. That couples the gate to import naming and would misfire on (a) a future deal with `HS-` in the name that isn't HubSpot-sourced, or (b) a HubSpot import whose number gets normalized off the prefix.

This follow-up replaces the prefix-sniff with a structural fix: a server-derived `isHubspotSourced` boolean flag that lives on every deal-shaped API response.

## What changed

| File | Change |
|---|---|
| `server/src/modules/deals/redact.ts` | `redactDealResponse` and `redactDealList` now inject `isHubspotSourced: boolean` (derived from `hubspotDealId != null` BEFORE the raw ID is conditionally stripped). New `DealResponseWithSourceFlag<T>` type. |
| `client/src/pages/deals/deal-detail-page.tsx` | Gate is now `isBidBoardOwned && !deal.isHubspotSourced && <BidBoardProjectSummaryPanel />`. `isHubspotImportedDealNumber` import dropped from this file. |
| `client/src/hooks/use-deals.ts` + `use-properties.ts` | `hubspotDealId` becomes optional on the wire; `isHubspotSourced: boolean` is required. |
| `server/src/api-spec.ts` | Documents both fields; `isHubspotSourced` added to the required set. |
| `server/src/modules/deals/routes.ts` | `POST /deals`, `PATCH /deals/:id`, `/:id/stage`, `/:id/proposal-draft`, `/:id/contract-signed-date` all now run through `redactDealResponse`. |
| `server/src/modules/contacts/routes.ts` | `GET /contacts/:id/deals` redacts every associated deal. |
| `server/src/modules/properties/routes.ts` | `GET /properties/:id` redacts the nested `deals` array. |
| `server/tests/modules/deals/redact.test.ts` | Three new assertions on source-flag derivation; parity for `redactDealList` in default + admin-opted modes. |
| `client/src/pages/deals/deal-detail-page.test.tsx` | Regression test models the exact post-redaction wire payload (`isHubspotSourced: true`, no `hubspotDealId`); `makeDealDetail` factory auto-derives `isHubspotSourced` from `hubspotDealId` so existing fixtures continue to work. |

## Consumer audit

Round-1 review caught that the original fix only covered four READ endpoints. The expanded fix covers ALL deal-returning endpoints — 7 in deals/routes.ts plus 2 cross-module endpoints. Every response that includes a deal object now goes through the redact helper.

Internal server-only paths (`server/src/modules/sales-review/ownership-sync-service.ts`, `server/src/modules/migration/`) still reference `hubspotDealId` because they operate on DB rows for sync/migration logic — they do not return data to HTTP clients.

The client codebase now has zero gates branching on `hubspotDealId` presence; the prior `isHubspotImportedDealNumber(dealNumber)` deal-number prefix sniff is gone from `DealDetailPage`. The utility itself still exists in `deal-utils.ts` for display formatting (via `formatDealDisplayNumber`), but it is no longer used for behavior gates.

## Subagent review rounds

| Round | Verdict | Findings |
|---|---|---|
| 1 (adversarial) | P1+ | 5 mutation endpoints + 2 cross-module GETs still leaked. Addressed in commit `eb5ebda`. |
| 2 (adversarial) | CLEAN | All P1s closed. One P2 (no integration tests for redaction call sites) accepted as future work. |

## Codex re-review

Comment posted on PR #258. PR #258 itself was MERGED before this fix-up could land on the same branch (timing — the original-PR owner's agent merged #258 ~minutes before #263 was ready). To avoid losing the fix, this fix was ported cleanly onto `main` as PR #265 and squash-merged.

## Why the original PR missed this

Diagnosis: incomplete consumer audit. The original implementer grep'd for places that **set** `hubspotDealId` (server-side migration helpers) and the one rendering of the ID on the detail page header, but did not grep for places that **branch** on its presence. The Bid Board gate `!deal.hubspotDealId` reads the field as a feature flag, not as content, so it didn't appear in a grep targeted at display sites.

**Lesson for future redaction work:** when stripping a field from an API response, grep for the field name on the CLIENT side too. Every conditional that references it is a candidate consumer. If any consumer uses the field as a feature flag rather than content, the redaction must supply a replacement signal in the response payload (this PR's `isHubspotSourced` is the pattern).

## Verification

- `npm run typecheck` exit 0 (shared, server, worker, client, client-field)
- `npx vitest run server/tests/modules/deals/redact.test.ts client/src/pages/deals/deal-detail-page.test.tsx` → 2 files, 49 tests pass

## Merge

| PR | Branch | Merge SHA | Note |
|---|---|---|---|
| #263 | `fix/deal-source-flag` (→ feat/deals-cleanup-and-audit) | `5b582a8` | First fix-up commit (the original branch was orphaned when #258 merged). |
| #265 | `fix/deal-source-flag-to-main` (→ main) | `7c80483` | Same content, cherry-picked onto main. **This is the merge that landed in prod.** |

## Deploy

Tracking Railway deploy after the merge of `7c80483`. Smoke results will be appended to `smoke.md`.

## Known issues / NEEDS INTERVENTION

- None. One P2 deferred: add integration tests that exercise the wire response from each of the seven patched endpoints and assert it contains `isHubspotSourced` and not `hubspotDealId`. Unit-level coverage of `redactDealResponse` is sufficient for ship.

## Worktree cleanup

- `trockcrm-deals-cleanup` (other agent) — left alone per coordination rule
- `trockcrm-deals-source-flag` (my isolated worktree for PR #263) — retained until smoke confirms
- `trockcrm-source-flag-main` (worktree for PR #265) — retained until smoke confirms
- `trockcrm-deals-final` (this docs branch) — retained until docs PR lands
