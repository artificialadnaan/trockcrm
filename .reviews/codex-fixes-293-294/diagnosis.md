# Codex P0/P1 Fixes for PR #293 and PR #294

## Finding 293-1 - Bid Board estimate writeback bypasses terminal guard

Root cause: `ingestBidBoardRows` calls `writeEstimateIfNeeded` immediately after the matched deal mirror update and before `writeStageIfSafe`. `writeStageIfSafe` has explicit terminal-stage and backward-stage guards, but `writeEstimateIfNeeded` currently only validates the incoming Total Sales value and audit user. A terminal Won/Lost deal can therefore keep receiving `bid_estimate` writes on every Bid Board export cycle.

Fix direction: add the terminal-stage guard directly to `writeEstimateIfNeeded`, using the same `stage_is_terminal` and `isTerminalWorkflowStage(stage_slug, workflow_route)` checks as stage writeback. Add a dedicated `estimate_skipped_terminal_count` metric because the existing `skipped_terminal_count` describes stage writeback, not financial-field writeback.

Mirror field note: the broader Bid Board mirror columns (`bid_board_total_sales`, status, due date, etc.) still update for matched rows. That preserves audit visibility into the latest Bid Board export without rewriting the CRM-owned financial estimate on terminal deals.

## Finding 294-1 - Legacy Bid Board records do not show locked state for admin force edit

Root cause: `assertDealScopingEditable` uses `inferDealBidBoardOwnership`, including `bidBoardStageSlug`, to reject writes for legacy downstream Bid Board-owned stages. `resolveDealScopeLockState` has its own narrower handoff predicate and omitted `bidBoardStageSlug`. That split means the UI can receive `locked=false`, but a save still falls through to `assertDealScopingEditable` and fails with `BID_BOARD_OWNED_STAGE_READ_ONLY`.

Fix direction: align lock-state detection with the ownership assertion by using one helper to build the Bid Board ownership input and include legacy ownership signals, especially `bidBoardStageSlug`. This keeps the read-only/force-edit UI contract consistent with the backend write gate.

## Finding 294-3 - Locked deal file mutations lack a reliable admin force-edit path

Root cause: file routes already parse `forceEditAfterRfp`, but the scoping lock helper only executes when a file is marked as a scoping-intake attachment (`intakeSource='scoping_intake'` and `intakeRequirementKey` present). Regular files linked to locked deals can bypass the lock, while scoping-linked files require the flag. The intended post-PR #294 behavior is deal-level consistency: file metadata/address/delete/new-version actions on a locked deal should be blocked unless an admin explicitly forces edit.

Fix direction: replace the scoping-only file helper with a deal-file mutation helper. If a file has a `dealId`, call `assertDealScopingWriteAllowed` with the parsed `forceEditAfterRfp` flag. Preserve existing audit rows when the admin override is used, and continue avoiding this guard for lead/contact/unassigned files.

## Deferred

The prompt explicitly defers the 404-to-403 API behavior and company selector cancellation edge case. They are not included in this branch.
