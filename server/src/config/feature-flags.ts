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
