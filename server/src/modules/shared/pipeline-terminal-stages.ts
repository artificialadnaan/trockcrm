import {
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
  LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE,
  LOST_DEAL_STAGE_SLUGS,
  WON_DEAL_STAGE_SLUGS,
  isTerminalWorkflowStage,
} from "@trock-crm/shared/types";

const legacyTerminalStageSlugs = Object.values(LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE).flatMap((stageMap) =>
  Object.entries(stageMap)
    .filter(([, canonicalSlug]) => isTerminalWorkflowStage(canonicalSlug))
    .map(([slug]) => slug)
);

export const TERMINAL_STAGE_SLUGS = [
  ...new Set([...CANONICAL_TERMINAL_DEAL_STAGE_SLUGS, ...legacyTerminalStageSlugs]),
] as readonly string[];

export const WON_STAGE_SLUGS = WON_DEAL_STAGE_SLUGS;
export const LOST_STAGE_SLUGS = LOST_DEAL_STAGE_SLUGS;
