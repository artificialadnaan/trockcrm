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
