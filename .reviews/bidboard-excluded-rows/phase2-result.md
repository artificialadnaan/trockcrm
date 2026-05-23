# Phase 2 Result: Approved Excluded Bid Board Rows

## Scope

Created exactly the two human-approved rows from the Phase 1 excluded-row review:

| Project # | Bid Board Status | CRM Stage | Owner Handling |
|---|---|---|---|
| 1-PTW.1-101025 | Service - Estimating | service_estimating | fallback assignment review |
| DFW-6-06426-zz | Lost | lost | fallback assignment review |

No other excluded rows were created.

## Dry-Check

The required rolled-back dry-check ran first in a single transaction.

- Expected creates: 2
- Would create: 2
- Result: ROLLBACK

## Commit

The real create ran after the dry-check matched the approved count.

- Committed creates: 2
- Transaction mode: single transaction
- On failure behavior: rollback all
- Owner recovery: no HubSpot Project Number matches found for either row, so both used the approved fallback owner with `bid_board_import_assignment_review`
- Source: `bid_board_import`
- Bid Board ownership: `is_bid_board_owned = true`
- Read-only mirror: `is_read_only_mirror = true`

Created CRM deal IDs were verified locally and are intentionally omitted from this committed report.

## Verification

Post-commit SELECT-only verification found exactly 2 matching active CRM deals by normalized project number:

- `1-PTW.1-101025`: stage `service_estimating`, source `bid_board_import`, fallback assignment review, not on hold
- `DFW-6-06426-zz`: stage `lost`, source `bid_board_import`, fallback assignment review, not on hold

## Backup

Pre-change backup snapshot:

`.reviews/bidboard-excluded-rows/prechange-backup-2026-05-23T03-21-19-712Z.json`
