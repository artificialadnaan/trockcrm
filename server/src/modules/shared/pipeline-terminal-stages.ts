import {
  LOST_DEAL_STAGE_SLUGS,
  TERMINAL_DEAL_STAGE_SLUGS,
  WON_DEAL_STAGE_SLUGS,
} from "@trock-crm/shared/types";

// The union moved to shared/src/types/deal-reporting.ts so the worker's raw-SQL exclusion twins render
// from the SAME list the server's drizzle builders do. Re-exported rather than re-derived: two copies of
// "which stages mean realized" is how a stage rename ends up terminal on one surface and open on another,
// and the surfaces that would disagree are a report's population and the dollars it quotes.
export const TERMINAL_STAGE_SLUGS = TERMINAL_DEAL_STAGE_SLUGS;

export const WON_STAGE_SLUGS = WON_DEAL_STAGE_SLUGS;
export const LOST_STAGE_SLUGS = LOST_DEAL_STAGE_SLUGS;
