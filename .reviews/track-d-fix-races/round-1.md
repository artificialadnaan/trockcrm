# Review Round 1

Reviewer: subagent `019e1373-73cf-72a1-8a11-775d62f0a8e2`
Date: 2026-05-10

## Finding

Medium: The conditional reservation only guarded `is_bid_board_owned = false`. The precheck rejects inferred Bid Board ownership from mirror/read-only fields, but a concurrent mirror update that sets those fields without also setting `is_bid_board_owned` could still reserve and enqueue.

Fields involved:

- `bid_board_stage_slug`
- `is_read_only_mirror`
- `read_only_synced_at`
- `bid_board_stage_entered_at`
- `bid_board_mirror_source_entered_at`

## Verified Clean

- Conditional deal reservation, RFP delivery job insert, domain event insert, and commit are in the same request transaction.
- Enqueue helper uses caller-provided `tenantDb`; no separate connection.
- Rep ownership guard and admin bypass are correct for the guarded update.
- Zero-row reservation exits before job insert and returns structured errors.
- Client feature flag hides the button.
- Readiness callback is signature gated and does not create an obvious infinite loop.
- Trigger failure and post-success refetch failure are separated.

## Fix Plan

Add the inferred Bid Board ownership mirror fields to the atomic reservation guard and to the conflict classification. Add a route regression where `bidBoardStageSlug` changes between precheck and reservation and assert no RFP job is inserted.
