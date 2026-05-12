# Known Issues — deals-cleanup-and-pre-golive-audit

Non-blocking issues identified during review. Documented for post-go-live follow-up.

## P2 — Deferred from subagent review round 1

### Remaining surfaces that still render `deal.dealNumber` raw

The PR updated the highest-visibility surfaces (deal detail header, kanban
cards, deal list cards, deal overview tab, deal search results, deal card,
contact deals tab, email thread view, task create dialog). The following
surfaces still render `deal.dealNumber` raw and will show `HS-...` for
HubSpot-imported deals. Each needs the `formatDealDisplayNumber(deal).label`
treatment.

| File | Line | Context | Visibility |
|---|---|---|---|
| `client/src/components/deals/deal-form.tsx` | 231 | Edit form header | Med |
| `client/src/pages/deals/deal-edit-page.tsx` | 44 | Edit page title | Med |
| `client/src/components/ai/intervention-detail-panel.tsx` | 119 | AI intervention panel | Low (admin) |
| `client/src/components/email/email-manual-assignment-dialog.tsx` | 156 | Manual assignment | Low |
| `client/src/components/email/email-assignment-queue-view.tsx` | 76 | Assignment queue | Med |
| `client/src/components/companies/company-copilot-panel.tsx` | 101 | Company AI panel | Low |
| `client/src/pages/admin/rep-commissions-page.tsx` | 484 | Director report | Low (director) |
| `client/src/pages/admin/procore-sync-page.tsx` | 186 | Admin sync page | Low (admin) |
| `client/src/pages/deals/deal-list-page.tsx` | 189 | CSV export column | Med (export only) |
| `client/src/pages/admin/contracts-signed-page.tsx` | 165 | Contracts list | Low (director) |
| `client/src/pages/companies/company-detail-page.tsx` | 744, 1059 | Company deals list | Med |
| `client/src/pages/properties/property-detail-page.tsx` | 603 | Property deals list | Med |
| `client/src/pages/files/files-page.tsx` | 115, 588 | Files page deal column | Low |

Post-merge follow-up: file a GitHub issue tagged `audit-2026-05` to update
each surface to use the helper. Estimate ~30 min total — mechanical edit
plus type guard for surfaces with stricter local Deal types.

### Other P2 / non-blocking from round 1

- **System IDs "Deal ID" label semantics** (`deal-detail-page.tsx:1043-1049`).
  Now renders the project number rather than a system identifier. Could
  rename the field to "Reference" or "Project number" for accuracy. Deferred
  because the PR's intent is to hide HS- prefixes everywhere; showing
  project number here is consistent with the rest of the page.

- **`hubspotDealId` type still non-optional** (`client/src/hooks/use-deals.ts:180`).
  After server redaction the field is `undefined` on the wire but the type
  says `string | null`. TypeScript doesn't enforce wire shape, so this is
  cosmetic. Update to `hubspotDealId?: string | null` post-merge.

- **No idempotency unit test for Phase B script's audit-marker exclusion**.
  The DB-level filter `COALESCE(hubspot_extra_properties->'phase_b_reassignment'->>'reassigned_at', '') = ''`
  is exercised in the prod dry-run + execute pass, but not in unit tests.
  Could add a SQL-emission test that asserts the WHERE clause is present.

- **`intervention-detail-panel.tsx:119`** renders `detail.crm.deal.dealNumber`
  off a different deal shape than the standard `Deal` type. Use the helper
  there too, but it requires confirming the AI intervention API response
  shape includes `projectNumber`. Listed above as the first follow-up surface.

## P1 from round 1 — RESOLVED in this PR

- ~~`/api/deals/pipeline` and `/api/deals/stages/:stageId` did not redact `hubspotDealId`~~ → fixed in `server/src/modules/deals/routes.ts`.
- ~~13+ client surfaces still rendered `deal.dealNumber` raw~~ → partially fixed: highest-visibility surfaces (deal-card, contact-deals-tab, email-thread-view, task-create-dialog) now use the helper. Remaining surfaces listed above for follow-up.

## Coordination with stale PRs

- **PR #212** (`fix/project-number-uppercase`) — its sole commit (`a4411d2`) is already on `main` from a different path (PR #217). PR #212 is stale and will be closed with a `superseded by #258` comment after this PR merges.
- **PR #40** (`feat/sales-dashboard-funnel-realignment`) and **PR #42** (`feat/crm-first-email-intake`) — both 12 days old, both touch `client/src/pages/deals/deal-list-page.tsx`. The file's only change in this PR is via the shared kanban card (no direct edits to deal-list-page.tsx itself), but PR #40/#42 add a sales funnel filter UI that could conflict if rebased. User to decide whether to close them or rebase post-merge.
