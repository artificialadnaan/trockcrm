export function isOpportunityRfpEventEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_OPPORTUNITY_RFP_EVENT === "true";
}

export function isContractSignedHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_CONTRACT_SIGNED_HANDOFF !== "false";
}

export function isContractStageSelectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_CONTRACT_STAGE_SELECTION !== "false";
}

export function isAuthDemoBootstrapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_AUTH_DEMO_BOOTSTRAP === "true";
}

/**
 * Gates filtering on the entered-current-stage date (and the days-in-stage /
 * "stalled" filter), both of which read deals.stage_entered_at. That column is
 * only reliable for deals that transition FORWARD after PR #535; legacy/imported
 * deals carry a placeholder. When OFF, the open-stage date window is not applied
 * (open rows stay current-state, never silently dropped) and the stalled filter
 * is omitted. Won/Lost date windows are unaffected (reliable now).
 */
export function isStageEntryDateFilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_STAGE_ENTRY_DATE_FILTER === "true";
}

/**
 * Gates the non-service RFP three-voter branch of POST /:id/trigger-rfp. OFF (default) = non-service deals
 * keep the existing single-approver SyncHub email path, so the voting feature ships inert until flipped.
 * Service / type-4 deals ignore this flag (always SyncHub email path).
 */
export function isRfpVotingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_RFP_VOTING === "true";
}

/**
 * Gates the Bid Board due-date read-back — BOTH halves: the ingest write-through that copies the export's
 * Due Date onto `deals.bid_due_date`, and the read precedence that lets `deals.bid_board_due_date` win on
 * the deal-detail banner / resolved fields / RFP payload. Default OFF.
 *
 * Both halves have to be gated for "ships inert" to be true. `bid_board_due_date` is ALREADY populated on
 * prod (the ingest mirror has been writing it all along and nothing has ever read it), so shipping only the
 * read precedence would immediately change the banner date — and, because getDealDetail feeds the resolved
 * date into attachAtRiskResult, the deal's at-risk verdict and effective VALUE — for every deal already
 * carrying a mirror value, with the write-through still off.
 *
 * The reason a flag exists at all: since 2026-07-27 `bid_due_date` is the auto-park horizon for genuine
 * estimating-stage deals (shared/src/types/deal-hold-risk.ts + its SQL twin holdHorizonDateSql), so a
 * horizon more than 90 CT-days out zeroes the deal's value on cards, dashboards, at-risk counts and worker
 * rollups. This sync runs on a SCHEDULE, so unlike a manual prod write there is no human gate between
 * deploy and the first mass write. Sequence: ship inert -> run the census -> flip in Railway -> watch the
 * next run's bidDueDateUpdated metric.
 */
export function isBidBoardDueDateReadbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BID_BOARD_DUE_DATE_READBACK === "true";
}
