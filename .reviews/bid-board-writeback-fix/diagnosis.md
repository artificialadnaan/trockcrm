# Bid Board Writeback Diagnosis

Date: 2026-05-12  
Branch: `fix/bid-board-writeback-stage-sync`  
Repo: `/Users/adnaaniqbal/projects/trockcrm`  
Mode: diagnosis before implementation.

## Summary

Root cause is in the CRM Bid Board export ingestion service, not in the Excel parsing job itself.

The 10-minute export sync posts parsed rows to `POST /api/bid-board-sync/ingest`. CRM receives the rows and records sync runs, but matching currently checks:

1. `procore_bid_id = BidBoard Project ID`
2. `bid_board_project_number = Project #`
3. `name + bid_board_created_at`

On a first useful sync, `bid_board_project_number` is still null in CRM, so the exported `Project #` cannot match the CRM deal that owns that number. Production shows this clearly: latest run processed 488 rows, updated 0, and no-matched 488.

The export `Project #` should match CRM's external project-number token. In current production, that token may live in either:

- `office_dallas.deals.project_number` for imported/backfilled records
- `office_dallas.deals.deal_number` for CRM-generated/RFP records such as Jasonn Ranches

Therefore the safe matching order should be:

1. numeric Bid Board/Procore ID against `procore_bid_id`
2. case-insensitive `Project #` against `project_number`
3. case-insensitive `Project #` against `deal_number`
4. existing `bid_board_project_number`
5. legacy name+created fallback

## Current Code Surface

Endpoint:

- `server/src/app.ts:104-106` mounts `/api/bid-board-sync`.
- `server/src/modules/bid-board-sync/routes.ts` verifies `x-bid-board-sync-signature` using `BID_BOARD_SYNC_SECRET` and calls `ingestBidBoardRows`.

Service:

- `server/src/modules/bid-board-sync/service.ts`
- Normalizes rows from the Excel export columns: `Name`, `Estimator`, `Office`, `Status`, `Sales Price Per Area`, `Project Cost`, `Profit Margin`, `Total Sales`, `Created Date`, `Due Date`, `Customer Name`, `Customer Contact`, `Project #`.
- Writes flat Bid Board metadata fields.
- Does not currently update `stage_id`.
- Tracks per-run counts in tenant table `bid_board_sync_runs`.

Current match bug:

```ts
if (row.bidBoardProjectNumber) {
  const byProject = await client.query(
    `SELECT id FROM ${schemaName}.deals WHERE bid_board_project_number = $1`,
    [row.bidBoardProjectNumber]
  );
}
```

That compares the incoming Project # to the mirror field that would only be populated after a successful match.

## Production Evidence

Latest production sync run:

| row_count | updated_count | no_match_count | warning_count | structured_no_match_warnings | null_project_number_warnings | duplicate_project_number_warnings | due_date_warnings |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 488 | 0 | 488 | 235 | 176 | 50 | 6 | 3 |

Read-only comparison of the latest structured no-match Project # warnings against CRM:

| sampled_project_numbers | exact_deal_number_matches | exact_project_number_matches | casefold_deal_number_matches | casefold_project_number_matches |
|---:|---:|---:|---:|---:|
| 176 | 2 | 152 | 2 | 152 |

This means at least 154 of the "no match" rows would have matched if CRM compared Bid Board `Project #` to CRM `project_number`/`deal_number` instead of only `bid_board_project_number`.

Jasonn Ranches production check:

| deal_number | project_number | bid_board_project_number | name | stage_slug | is_bid_board_owned | rfp_approval_status |
|---|---|---|---|---|---:|---|
| DFW-2-13226-ab | null | null | jasonn ranches | estimate_in_progress | true | approved |
| DFW-3-13226-aa | null | null | jasonn ranches | opportunity | false | pending |

For these records, exported `Project #` can only match CRM via `deal_number` unless a later data hygiene pass backfills `project_number`.

## Stage Mapping

No shared Bid Board status-to-CRM-stage helper exists today. The closest mapping is in `server/src/modules/procore/bidboard-mirror-service.ts`, but that is tied to the SyncHub opportunities webhook and workflow-route-specific stage-family validation.

Required Excel status mapping for this fix:

| Bid Board Status | CRM Stage |
|---|---|
| Estimate in Progress | estimating |
| Service - Estimating | estimating |
| Estimate Under Review | estimate_under_review |
| Estimate Sent to Client | estimate_sent_to_client |
| Contract | contract |
| Won | won |
| Lost | lost |
| Templates | skip |

Assumption: `Service - Estimating` maps to canonical `estimating` per the prompt, even though the CRM also has `service_estimating` for service-route-specific display. The Excel export is being treated as the source-of-truth stage signal, and both estimating flavors represent the same business stage for this sync pass.

## Canonical Stage Source

Canonical deal stages are defined in `shared/src/types/workflow.ts`:

- `opportunity`
- `estimating`
- `service_estimating`
- `estimate_under_review`
- `estimate_sent_to_client`
- `contract`
- `won`
- `lost`

Production `pipeline_stage_config` has active canonical `estimating` and inactive legacy `estimate_in_progress`.

## RFP Callback Bug

`server/src/modules/internal-rfp/routes.ts` contains:

```ts
function bidBoardCreatedTargetStageSlug(workflowRoute: unknown) {
  return workflowRoute === "service" ? "service_estimating" : "estimate_in_progress";
}
```

That sends normal-route callback-created deals to legacy inactive `estimate_in_progress`. This explains why newly approved RFP-linked records can land in the legacy stage. The callback target should be canonical `estimating` for normal deals.

I am not recommending a broad data migration in this prompt because the user explicitly excluded migrating the 757 historical rows. The code fix should stop future writes to the legacy stage.

## Safety Requirements For Implementation

- Match Project # case-insensitively and trim whitespace.
- If multiple CRM deals match the same Project # token, skip and warn.
- Skip `Templates`, null/empty statuses, and unmapped statuses.
- Skip rows with null/empty Project #.
- Do not update stage if the translated CRM stage equals the current canonical stage.
- Do not move backwards in stage order.
- Do not move a terminal CRM deal (`won` or `lost`) to any non-identical stage.
- Write `deal_stage_history` only when `stage_id` changes.
- Mark changes as system/Bid Board initiated with `override_reason = 'Bid Board export sync - Status <X> -> Stage <Y>'`.
- Avoid rep notifications by not emitting `deal.stage.changed` domain events from the Excel export path.
- Keep updating existing flat Bid Board metadata fields.
- Expand `bid_board_sync_runs` reporting with stage update/match/skip counts and unmatched project-number samples.

## Implementation Plan

1. Add shared status mapping helper with tests.
2. Add failing service tests for Project # matching against `project_number`/`deal_number`, stage writeback, terminal/backward protection, and idempotency.
3. Update Bid Board ingestion to normalize rows from either `rows` or workbook-like `sheets` payloads.
4. Update matching to use `project_number` and `deal_number` before mirror-field fallback.
5. Add stage writeback with canonical stage lookup, safety rails, and audit/history insert.
6. Add migration and shared schema fields for sync-run reporting metrics.
7. Change RFP callback normal target from `estimate_in_progress` to `estimating` and update tests.
8. Run targeted tests, then full relevant checks.
