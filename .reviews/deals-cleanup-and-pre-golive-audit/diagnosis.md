# Deals Cleanup + Pre-Go-Live Audit — Diagnosis

Date: 2026-05-11
Branch: `feat/deals-cleanup-and-audit`
Worktree: `/Users/adnaaniqbal/projects/trockcrm-deals-cleanup`

## Phase A — HubSpot IDs visible to users

**Symptom:** Steeplechase deal detail page shows `HS-324283495135` under the deal name. Should never be visible to users.

**Root cause:** Multiple UI surfaces and one API field expose either the HubSpot deal ID column directly (`hubspotDealId`) or the `dealNumber` column whose value for HubSpot-imported deals is the same `HS-...` string.

**Surfaces identified:**
- `client/src/pages/deals/deal-detail-page.tsx:1043-1046` — explicit `<DetailRailItem label="HubSpot" value={hubspotDealId}/>` row.
- `client/src/pages/deals/deal-detail-page.tsx:619-620` — page-header subtitle slot rendering `deal.dealNumber` (the `HS-...` value for imports).
- `client/src/pages/deals/deal-detail-page.tsx:1041` — "Deal ID" row in System IDs section rendering `deal.dealNumber`.
- `client/src/pages/deals/deal-detail-page.tsx:1024-1028` — "Project Number" section fallback rendering `deal.dealNumber`.
- `client/src/components/deals/kanban-deal-card.tsx:7-11` — `getDealDisplayNumber()` helper falls back to `dealNumber` which surfaces `HS-...` for imports across kanban cards, list rows, decorated cards.
- `client/src/components/deals/deal-overview-tab.tsx:167` — Details card renders `deal.dealNumber` under "Deal Number".
- `server/src/modules/search/service.ts:288` — global search returns `secondaryLabel: r.deal_number` which surfaces `HS-...` as a secondary label for imported deals.
- `server/src/modules/deals/service.ts` (getDealById, getDealDetail, getDeals) — Drizzle `getTableColumns(deals)` returns every column including `hubspotDealId` in every list and detail response.

## Phase B — 45 HubSpot-imported deals stuck in Opportunity

**Symptom:** "Hubspot Missing Deals Import 2026 05 11" batch landed every deal in Opportunity regardless of HubSpot stage.

**Discovery (see `phase-b-discovery.md` for the full report):**
- Actual count is **34** deals, not 45 — all in `office_dallas`. Identifier: `deals.source = 'hubspot_missing_deals_import_2026_05_11'`.
- 24 of 34 are currently in Opportunity stage `03ab1b79-9412-43ec-82b4-624e0a60fd19`. The other 10 already landed in correct stages (`estimating`, `service_estimating`, `lost`, `estimate_sent_to_client`) via the import script's `workflow_decision` heuristic.
- Original HubSpot stage label is preserved on each deal at `hubspot_extra_properties->>'hubspot_stage_name'`. No HubSpot API call required.
- Distribution among the 24 stuck deals: **22 × "Pipe Line"** + **2 × "RFP"**.

**Mapping decision:** Both HubSpot stages map to `dd` (Due Diligence, UUID `0416a7db-1e5a-4d0a-88a2-bc5f1480755c`).
- Rationale: same `standard_deal` workflow family as Opportunity (no cross-family side effects); `display_order=1` so it sits one notch earlier than Opportunity, matching the brief's "early-funnel" guidance for top-of-funnel HubSpot stages.

## Phase C — Due diligence email + recipients page broken

**Symptoms:**
1. Recipients management page at `/admin/notification-recipients` fails to load.
2. A recent DD submission created a `pending` approval row but no notification email fired.

**Discovery (see `phase-c-diagnosis.md` for the full report):**
- HTTP repro: `GET /api/admin/notification-recipient-groups/lead_due_diligence` returns **HTTP 404** with body `{"error":{"message":"Notification recipient group not found"}}`. Not 5xx.
- DB state: `public.notification_recipient_groups` is **empty in production**. The `lead_due_diligence` group row does not exist. Migration `0079_notification_recipient_groups.sql` is recorded as applied in `public._migrations` (2026-05-05) but the table has 0 rows — only the `CREATE TABLE` persisted; the `INSERT` did not.
- The fallback "all active admins/directors" (added in commit `c509f86` on 2026-05-11 16:36 UTC) was committed AFTER the two stuck `pending` DD rows were created, so they could never benefit from it. They have `email_sent_at = NULL`.

**Root cause:** Server code throws 404 when the well-known group row is missing. The recipients page treats 404 as fatal. The email dispatch path needs to resolve a group id before falling back to admins — that join returns zero rows and the recipients query returns empty, so the dispatch returns `{ success: false }` silently.

## Phase D — Pre-go-live audit

Full results in `audit-findings.md`. **No P0 / go-live-blocking findings.** 5 P1 (most notable: 15+ `as any` casts at API boundaries; 18 of 30 server modules with zero tests), 5 P2.

## Proposed fixes (each scoped to a phase)

### Phase A — UI hide + API redaction

- Add shared client helper `formatDealDisplayNumber(deal)` that returns `{ label, isFallback, isPending }`. Label is `projectNumber` if set; otherwise `dealNumber` if not an `HS-*` pattern; otherwise the string `"Pending"`.
- Replace every `deal.dealNumber` / `deal.hubspotDealId` rendering surface with the helper.
- Remove the explicit "HubSpot" row from System IDs entirely.
- Server: add `server/src/modules/deals/redact.ts` exporting `redactDealResponse` / `redactDealList` / `shouldIncludeHubspotId`. Apply in `routes.ts` for `GET /`, `GET /:id`, `GET /:id/detail`. Default-strip `hubspotDealId`; honor `?includeHubspotId=true` only when user role is `admin`.
- Server: add `pickDealSecondaryLabel(projectNumber, dealNumber)` in `search/service.ts`. Prefer project number; reject HS-prefixed deal numbers from search results.

### Phase B — Stage reassignment script

- Add `scripts/reassign-hubspot-import-stages.ts`:
  - Default `--dry-run`; requires `--execute` + interactive `y` to write.
  - Idempotent — skips deals already moved (audit marker in `hubspot_extra_properties.phase_b_reassignment`) AND skips deals whose current stage is no longer Opportunity.
  - Writes audit CSV to `docs/audit/hubspot-stage-reassignment-<ts>.csv`.
  - Per-deal transaction: updates `stage_id` + `stage_entered_at` + audit marker, then inserts an audit row into `deal_stage_history`. Rolls back on any per-row error so prior rows stay clean.
- Register in `scripts/run-script.ts`.

### Phase C — DD notifications

- `due-diligence-service.ts`: introduce `WELL_KNOWN_GROUPS` registry + `ensureWellKnownGroup()` that performs `INSERT … ON CONFLICT DO NOTHING RETURNING`. Both `getNotificationRecipientGroup` and `updateNotificationRecipientAssignments` now lazy-upsert the known `lead_due_diligence` group on read, so the page loads even if the seed never landed.
- Add `migrations/0111_lead_dd_recipient_reseed.sql`: idempotent re-seed of the `lead_due_diligence` group row and its two known recipient assignments. Belt-and-suspenders if Drizzle's `applyAll` skips the table.

### Phase D — Audit

Read-only audit findings written to `audit-findings.md`. P0: none. P1 items filed as follow-up GitHub issues post-merge (see final.md).

## Out of scope for this PR (deferred follow-ups)

- Director-only "Resend DD email" action for stuck `pending` approvals (TODO already noted in `routes.ts:332`).
- Adding `tenantMiddleware` to `/admin/notification-recipient-groups/:key` routes — the diagnosis confirmed this is NOT the root cause of either reported bug (both tables are in `public` schema). Tracked as a P1 audit finding for post-go-live.
- Backfill of HubSpot-imported deals' `project_number` field so they show a real number instead of "Pending". The 34 deals' display will say "Pending" until rep assigns a real project number — that's the brief's expected fallback.
- Closing PR #212 — superseded by this PR; will be closed with a note on merge.
- Resolving PRs #40 and #42 — 12 days stale, both touch `deal-list-page.tsx`. Documented for the user to triage post-merge.
