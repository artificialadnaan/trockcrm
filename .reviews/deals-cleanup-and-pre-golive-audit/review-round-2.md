# Review Round 2 — PR #258

## Verdict
**CLEAN** — no P0 or P1 blockers. Two minor P2s, neither is a security or correctness regression.

## P0 / P1 findings

None.

## P2 findings (non-blocking)

### P2-NEW-1. `/api/deals/stages/:stageId` redaction targets wrong property name

- **File:** `server/src/modules/deals/routes.ts:419-422`
- **Code:** `deals: result.deals ? redactDealList(result.deals, { includeHubspotId }) : result.deals`
- **Issue:** `listDealStagePage()` returns `{ stage, scope, summary, pagination, rows }` — no `.deals` field. `result.deals` is `undefined`, so the spurious `deals: undefined` key is added to the response. The real array (`rows`) is built from a raw SQL query that does NOT select `hubspot_deal_id`, and `mapDealStageWorkspaceRow` does not pass it through — so the endpoint was never leaking `hubspotDealId` in the first place.
- **Severity:** P2 only. Dead code, not a security gap.
- **Suggested fix:** Remove the dead redaction on this endpoint, OR rename the assignment to `rows: result.rows ...`. The former is simpler and matches actual behavior. Will land in a follow-up commit.

### P2-NEW-2. `review-round-1.md` mentions credential strings in narrative prose

- **File:** `.reviews/deals-cleanup-and-pre-golive-audit/review-round-1.md`
- **Issue:** Document mentions `dev123!`, `TrockTest123!`, and Railway hostnames in prose describing PRE-EXISTING issues in OTHER `.reviews/` directories — not in code or config in this PR. These are descriptive references, not committed credentials.
- **Severity:** P2. Style/redaction hygiene.

## Round 1 follow-up status

- **P1-1 (extra API endpoints leaked hubspotDealId):**
  - `/api/deals/pipeline`: **VERIFIED FIXED.** `redactDealList` correctly applied to both `pipelineColumns[].deals` and `terminalStages[].deals`. Schema confirms `hubspotDealId` was in the payload via `getTableColumns(deals)`.
  - `/api/deals/stages/:stageId`: **Never actually leaking.** The endpoint's raw SQL never selects `hubspot_deal_id` and the row mapper does not include it. The redaction added in round 1 is dead code (P2-NEW-1 above). Functionally fine but redundant.

- **P1-2 (13+ client surfaces still rendered raw dealNumber):** **Partial fix accepted.** Four highest-visibility surfaces updated: `deal-card.tsx`, `contact-deals-tab.tsx`, `email-thread-view.tsx`, `task-create-dialog.tsx`. All typecheck against their respective Deal shapes (local types updated where needed to add `projectNumber?: string | null`). Remaining 13 lower-visibility surfaces deferred to a post-merge follow-up, tracked in `known-issues.md` with file:line table.

- **P2-3 (migration 0111 ON CONFLICT DO UPDATE):** **VERIFIED FIXED.** Changed to `DO NOTHING` — preserves admin customizations of group name/description.

- **P2-5 (BidBoardProjectSummaryPanel guard inverts on redaction):** **VERIFIED FIXED.** Guard now reads `isBidBoardOwned && !deal.hubspotDealId && !isHubspotImportedDealNumber(deal.dealNumber)`. Handles both pre-redaction (raw `hubspotDealId` present) and post-redaction (only `dealNumber` available) signals.

## Notes

- No new `as any`, missing `await`, or swallowed catches introduced in commit `e16ca67`.
- `known-issues.md` table of 13 deferred surfaces is accurate (spot-checked `deal-form.tsx:231` and `email-assignment-queue-view.tsx:76` — both still render raw `dealNumber`).
- The `formatDealDisplayNumber` helper's cascade (`projectNumber → non-HS dealNumber → "Pending"`) is well-designed and ready to apply to the remaining surfaces post-merge.
- One minor cleanup remaining (P2-NEW-1) will land before merge.

**Verdict: CLEAN.** Safe to land after the P2-NEW-1 stages-endpoint cleanup.
