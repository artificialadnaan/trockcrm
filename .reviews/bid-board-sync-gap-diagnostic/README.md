# Bid Board Sync Gap Diagnostic

## Purpose

This diagnostic compares active CRM deals against the three historical source systems:

- HubSpot deals
- Procore Bid Board records
- Procore Portfolio projects

It is read-only. It does not call CRM sync routes, does not enqueue jobs, does not update audit tables, and does not modify sync logic.

## Script

Run from the repo root:

```bash
npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --dry-run
```

The default output is JSON. For a meeting-friendly leadership summary, add `--format=text`:

```bash
npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --dry-run --format=text
```

Common options:

```bash
npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --full-report
npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --full-report --format=text
npx tsx scripts/bid-board-sync-gap-analysis.ts --all --dry-run
npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --source=hubspot --full-report
npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --source=bidboard --dry-run
npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --source=portfolio --dry-run
```

Production run after deploy:

```bash
railway run --service=Worker -- npx tsx scripts/bid-board-sync-gap-analysis.ts --office=office_dallas --dry-run
```

## Required Environment

- `DATABASE_PUBLIC_URL` or `DATABASE_URL` for CRM read queries.
- `HUBSPOT_PRIVATE_APP_TOKEN` when `--source=hubspot` or `--source=all`.
- `PROCORE_COMPANY_ID` and Procore read auth env when `--source=portfolio` or `--source=all`.
- `SYNCHUB_DATABASE_URL` when `--source=bidboard` or `--source=all`, unless `BID_BOARD_EXPORT_PATH` points at a local exported Bid Board JSON payload.

Bid Board source assumption: CRM has no first-party Bid Board listing API in this repo. When no `BID_BOARD_EXPORT_PATH` is supplied, the script reads SyncHub `sync_mappings` as the Bid Board source inventory. If leadership wants a full current Bid Board export, provide it as JSON through `BID_BOARD_EXPORT_PATH` and rerun.

## Matching Rules

CRM fields used:

- HubSpot: `deals.hubspot_deal_id`
- Bid Board ID: `deals.procore_bid_id`
- Bid Board project number: `deals.bid_board_project_number`
- Portfolio project: `deals.procore_project_id`

Exact source gaps are based on stored IDs first. The report also includes likely matches by project number and normalized name for leadership review, but those are advisory only and should not be auto-merged.

## Output

`--dry-run` prints counts only, plus the District at Pointon section.

`--full-report` includes row-level examples for:

- HubSpot deals missing from CRM
- Bid Board projects missing from CRM
- Portfolio projects missing from CRM
- CRM rows with missing or incorrect source IDs
- CRM orphan rows where HubSpot ID, Bid Board ID/project number, and Portfolio ID are all null
- CRM rows not found in any fetched source

## District at Pointon Worked Example

Every run includes a `districtAtPointon` section. It searches CRM, HubSpot, Bid Board, and Portfolio records by normalized name/project-number text and reports the CRM linkage fields:

- `hubspotDealId`
- `procoreBidId`
- `bidBoardProjectNumber`
- `procoreProjectId`

Interpretation:

- CRM match only: the source fetch did not find an upstream record with the same name/project number, or source credentials were incomplete.
- Bid Board match with no CRM `procoreBidId` or `bidBoardProjectNumber`: the Bid Board record exists but is not linked in CRM.
- Portfolio match with no CRM `procoreProjectId`: a likely skipped-Bid-Board or handoff gap.
- HubSpot match with no CRM `hubspotDealId`: legacy CRM linkage gap.

## Leadership Questions

- Should SyncHub `sync_mappings` be treated as sufficient Bid Board inventory, or should operations export the full current Bid Board dataset for this analysis?
- For Portfolio-only projects, should CRM consolidation prefer exact Procore `id`, project number, or a reviewed manual match list?
- Which missing-source buckets should be corrected first: District at Pointon class failures, active Portfolio-only work, or legacy HubSpot-only rows?
- Should follow-up PRs be split by source system so each consolidation step can be reviewed and verified independently?

## Explicit Non-Goals

- No sync-code changes.
- No writes to CRM, HubSpot, Procore, or SyncHub.
- No automatic merge or reconciliation.
- No changes to `server/src/modules/deals/service.ts`.
