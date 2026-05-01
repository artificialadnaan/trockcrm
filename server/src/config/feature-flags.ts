export function isOpportunityRfpEventEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_OPPORTUNITY_RFP_EVENT === "true";
}
