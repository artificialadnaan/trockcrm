import { describe, expect, it } from "vitest";
import { TERMINAL_STAGE_SLUGS } from "./pipeline-terminal-stages.js";

describe("server pipeline terminal stages", () => {
  it("includes genuine terminal stages and excludes pre-close transitional aliases", () => {
    expect(TERMINAL_STAGE_SLUGS).toEqual([
      "won",
      "lost",
      "sent_to_production",
      "service_sent_to_production",
      "service_scheduled",
      "service_complete",
      "closed_won",
      "deal_canceled",
      "production_lost",
      "service_lost",
      "closed_lost",
    ]);
    expect(TERMINAL_STAGE_SLUGS).not.toContain("in_production");
    expect(TERMINAL_STAGE_SLUGS).not.toContain("close_out");
    expect(TERMINAL_STAGE_SLUGS).not.toContain("estimating");
    expect(TERMINAL_STAGE_SLUGS).not.toContain("service_estimating");
  });
});
