# Review Round 1 — PR #258

**Reviewer:** code-reviewer (opus)
**Date:** 2026-05-11
**Branch:** `feat/deals-cleanup-and-audit`
**Files reviewed:** 24

## Verdict

**P1_FOUND**

No P0 data-loss or crash-on-go-live issues found. Two P1 correctness gaps identified that should be fixed before merge. Several P2 observations for post-go-live cleanup.

---

## P0 findings

None.

---

## P1 findings

### P1-1. `/api/deals/pipeline` and `/api/deals/stages/:stageId` do NOT redact `hubspotDealId`

**Files:** `server/src/modules/deals/routes.ts:375-401` (pipeline), `server/src/modules/deals/routes.ts:403-411` (stages)

**Issue:** Redaction is applied to `GET /api/deals` (line 357), `GET /api/deals/:id` (line 468), and `GET /api/deals/:id/detail` (line 483) — but the pipeline kanban endpoint (`GET /api/deals/pipeline`) and the stage drill-down endpoint (`GET /api/deals/stages/:stageId`) return their deal payloads without calling `redactDealList` or `redactDealResponse`. The `hubspotDealId` field will still be present in every pipeline deal JSON response.

**Impact:** While the client-side UI surfaces that consume these endpoints (kanban cards, deals-list-section) already use `formatDealDisplayNumber` and never render `hubspotDealId` in the DOM, the field is still transmitted over the wire. Any browser DevTools inspection, API client, or future consumer will see the raw HubSpot IDs. The Phase A requirement says "strip from default API responses" — these two endpoints violate that.

**Fix:** Apply `redactDealList` to the pipeline response deals (each stage's deal array) and to the stage page response before sending. Follow the same `shouldIncludeHubspotId` pattern used in the list/detail endpoints.

---

### P1-2. `deal.dealNumber` still rendered raw in 13+ client surfaces outside this PR's scope

**Files (not changed in this PR but still expose HS- prefix):**
- `client/src/components/deals/deal-card.tsx:57` — `{deal.dealNumber}`
- `client/src/components/deals/deal-form.tsx:231` — `<Input value={deal.dealNumber} disabled />`
- `client/src/pages/deals/deal-edit-page.tsx:44` — `{deal.dealNumber} - {deal.name}`
- `client/src/components/contacts/contact-deals-tab.tsx:79` — `{assoc.deal.dealNumber}`
- `client/src/components/ai/intervention-queue-table.tsx:85` — `{item.deal.dealNumber}`
- `client/src/components/ai/intervention-detail-panel.tsx:119` — `{detail.crm.deal.dealNumber}`
- `client/src/components/email/email-thread-view.tsx:116,136` — `{deal.dealNumber}`
- `client/src/components/email/email-manual-assignment-dialog.tsx:156` — template literal with `deal.dealNumber`
- `client/src/components/email/email-assignment-queue-view.tsx:76` — template literal with `deal.dealNumber`
- `client/src/components/ai/company-copilot-panel.tsx:101` — `{deal.dealNumber}`
- `client/src/pages/commissions/rep-commissions-page.tsx:484` — `deal.dealNumber`
- `client/src/pages/admin/procore-sync-page.tsx:186` — `deal.dealNumber`
- `client/src/pages/deals/deal-list-page.tsx:189` — CSV export column includes `deal.dealNumber`
- `client/src/pages/dashboard/contracts-signed-page.tsx:165` — `{deal.dealNumber}`
- `client/src/pages/companies/company-detail-page.tsx:744,1059` — `#{deal.dealNumber}`
- `client/src/pages/properties/property-detail-page.tsx:603` — `{deal.dealNumber}`
- `client/src/pages/files/files-page.tsx:115,588` — template with `deal.dealNumber`

**Issue:** The PR successfully hides HS- from the detail page, kanban cards, overview tab, pipeline page, and search results — but HubSpot-imported deals with `dealNumber = "HS-324283495135"` will still show that raw HS- string on all the surfaces listed above. This breaks the Phase A requirement: "Hide HubSpot deal IDs from **every** UI surface."

**Impact:** Users navigating to deal edit, contacts tab, email threads, intervention queue, company page, properties page, commissions page, CSV exports, or files page will see `HS-324283495135` displayed as the deal identifier.

**Fix:** Replace every `deal.dealNumber` render with `formatDealDisplayNumber(deal).label` (or the `getDealDisplayNumber` wrapper) across all surfaces. This is a mechanical search-and-replace. The helper is already exported from `@/lib/deal-utils`. Alternatively, consider doing this at the API layer by adding a computed `displayNumber` field to the deal response and having the client use that instead.

---

## P2 findings (non-blocking)

### P2-1. System IDs "Deal ID" label shows display number instead of actual deal identifier

**File:** `client/src/pages/deals/deal-detail-page.tsx:1043-1049`

**Issue:** The "System IDs" rail section renders `headerDisplayNumber.label` as the "Deal ID" value. For a deal with `projectNumber = "DFW-1-12826-aa"`, the "Deal ID" row shows the project number, not the actual system-generated deal number or UUID. This conflates two distinct identifiers. The "Deal ID" in a "System IDs" section should arguably be the internal `deal.id` (UUID) or `deal.dealNumber` — not the display-friendly project number.

**Severity:** Low — this is a UX semantics issue, not a data leak. The previous code was arguably worse (it showed raw `deal.dealNumber` which could be an HS- ID). But the current label is misleading for admins inspecting system identifiers.

**Fix:** Consider showing `deal.id` (the UUID) as "Deal ID" in the System IDs section, or rename the label to "Display ID" / "Project Number" to match what it actually shows.

### P2-2. No idempotency test for the reassignment script

**File:** `server/tests/scripts/reassign-hubspot-import-stages.test.ts`

**Issue:** The test exercises `planReassignment()` thoroughly (case insensitivity, unmapped stages, non-Opportunity deals) but does not test the idempotency path. The script filters out already-reassigned deals via `COALESCE(hubspot_extra_properties->'phase_b_reassignment'->>'reassigned_at', '') = ''` in the SQL query (`scripts/reassign-hubspot-import-stages.ts:137`), but no test verifies that a deal with the `phase_b_reassignment` marker is excluded from a second run. The `executePlan` function also uses optimistic concurrency (`WHERE stage_id = $5::uuid`) to prevent double-moves, but this is untested.

**Fix:** Add a test that creates a candidate array where one deal already has the JSON marker set, and verify that `loadCandidates` excludes it (this would require a DB test or a mock). For unit tests, verify that `executePlan` handles the `rowCount === 0` case correctly (already done implicitly but not explicitly asserted).

### P2-3. Reassignment script does not reset `stage_entered_at` to "now" — it does, ignore if intentional

**File:** `scripts/reassign-hubspot-import-stages.ts:247`

**Observation:** The script sets `stage_entered_at = NOW()` (line 247), which is correct. Stage age metrics will reflect the reassignment date, not the original HubSpot import date. This is the right behavior. No action needed.

### P2-4. Migration uses `ON CONFLICT ... DO UPDATE` which overwrites name/description

**File:** `migrations/0111_lead_dd_recipient_reseed.sql:17-20`

**Issue:** The migration uses `ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`. If an admin has customized the group name or description via the UI, this migration will overwrite their changes. Using `DO NOTHING` instead would be safer for a re-seed.

**Fix:** Change to `ON CONFLICT (key) DO NOTHING` if the goal is only to ensure the row exists. If the goal is to also standardize the name/description, the current behavior is acceptable.

### P2-5. Secrets in `.reviews/` from prior PRs (not this PR)

**Files:** `.reviews/projects-page-backfill/smoke.md`, `.reviews/reports-500-regression/diagnosis.md`, etc.

**Issue:** Prior PR review documents contain test account passwords (`dev123!`, `TrockTest123!`), a Railway production hostname (`api-production-ad218.up.railway.app`), a partial DATABASE_PUBLIC_URL reference (`trolley.proxy.rlwy.net`), and compiled server stack traces. These are NOT in the files changed by this PR — they are pre-existing in the repository from earlier PRs.

**Impact:** Low for this PR specifically, but these should be scrubbed from the repo history before go-live if the repo ever becomes less private.

**Note:** The `.reviews/deals-cleanup-and-pre-golive-audit/` directory (this PR's review docs) is clean — no secrets found.

### P2-6. `deal-detail-page.tsx:804` uses `deal.hubspotDealId` as a conditional guard

**File:** `client/src/pages/deals/deal-detail-page.tsx:804`

**Issue:** `{isBidBoardOwned && !deal.hubspotDealId && <BidBoardProjectSummaryPanel deal={deal} />}` — This reads `deal.hubspotDealId` for branching logic. After the server strips `hubspotDealId` from the response, this field will be `undefined` (not present), which is falsy, so `!deal.hubspotDealId` will be `true`. This means the `BidBoardProjectSummaryPanel` will now show for HubSpot-sourced deals that are also Bid Board owned — previously it was hidden. This is a semantic change from the redaction.

**Impact:** Only affects deals that are BOTH HubSpot-sourced AND Bid Board owned, which may be an empty set in practice. But the logic inversion is worth noting.

**Fix:** If the intent is to hide the panel for HubSpot-sourced deals, this condition needs a different signal (e.g., a `source` field check, or the server should provide a `isHubspotSourced` boolean separately from the raw ID).

### P2-7. `use-deals.ts:180` type still declares `hubspotDealId: string | null`

**File:** `client/src/hooks/use-deals.ts:180`

**Issue:** The TypeScript `Deal` type still declares `hubspotDealId: string | null`. After the server strips this field, the runtime value will be `undefined`, but the type says `string | null`. No consumer does `deal.hubspotDealId!` (non-null assertion), so this won't crash — but the type is now inaccurate. 

**Fix:** Change the type to `hubspotDealId?: string | null` (optional) to reflect the server may not include it.

---

## Notes / observations

### Positive observations

1. **Well-designed `formatDealDisplayNumber` helper** — The cascading logic (projectNumber -> non-HS dealNumber -> "Pending") with a clean return type `{ label, isFallback, isPending }` is easy to test and reuse. Good separation of concern.

2. **Thorough test coverage for the new helper** — `deal-utils.test.ts` covers the happy path, fallback, HS-prefix hiding, whitespace-only projectNumber, and null/undefined inputs.

3. **Server-side redaction is well-layered** — `shouldIncludeHubspotId` gating by admin role + explicit query param is a sound escape hatch for debugging. `redactDealResponse` and `redactDealList` are composable.

4. **Reassignment script safety** — Per-deal transactions, optimistic concurrency on `stage_id`, JSON marker for idempotency, audit CSV, dry-run by default with interactive confirmation for execute. This is production-safe.

5. **Lazy upsert for DD notification group** — `ensureWellKnownGroup` with `onConflictDoNothing` + SELECT fallback handles the race condition correctly. The unique index on `key` prevents duplicates even under concurrent reads.

6. **Migration is properly idempotent** — `ON CONFLICT` on the group insert, `ON CONFLICT (group_id, user_id) DO NOTHING` on the assignment insert. Safe to re-run.

7. **Test for HS-prefix never rendering on kanban** — The kanban card test explicitly asserts `expect(html).not.toContain("HS-321687989951")` and `expect(html).toContain("Pending")`. This is a direct regression test for the original bug.

### Architecture note

The PR correctly identifies that HubSpot IDs should be hidden, and implements the fix at both the UI layer (display number helper) and the API layer (redaction). However, the coverage is incomplete at both layers: the API misses 2 endpoints, and the UI misses 13+ surfaces. The fundamental issue is that `dealNumber` was used as a display identifier throughout the codebase before HubSpot imports injected HS- prefixed values into it. A more comprehensive fix would be to either (a) add a computed `displayNumber` to the API response so the client never needs to call the helper, or (b) systematically replace every `deal.dealNumber` render in one pass.
