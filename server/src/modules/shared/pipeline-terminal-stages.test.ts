import { describe, expect, it } from "vitest";
import { LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE, isTerminalWorkflowStage } from "@trock-crm/shared/types";
import { TERMINAL_STAGE_SLUGS } from "./pipeline-terminal-stages.js";

describe("server pipeline terminal stages", () => {
  it("includes canonical terminal stages and every terminal legacy alias from all workflow mappings", () => {
    const expectedLegacyTerminalSlugs = Object.values(LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE).flatMap((stageMap) =>
      Object.entries(stageMap)
        .filter(([, canonicalSlug]) => isTerminalWorkflowStage(canonicalSlug))
        .map(([slug]) => slug)
    );

    expect(TERMINAL_STAGE_SLUGS).toEqual(
      expect.arrayContaining([
        "won",
        "lost",
        "deal_canceled",
        "service_scheduled",
        "service_complete",
        ...expectedLegacyTerminalSlugs,
      ])
    );
    expect(TERMINAL_STAGE_SLUGS).not.toEqual(expect.arrayContaining(["estimating", "service_estimating"]));
  });
});
