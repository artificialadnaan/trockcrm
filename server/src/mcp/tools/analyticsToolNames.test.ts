import { describe, it, expect } from "vitest";
import { ANALYTICS_TOOL_NAMES, isAnalyticsTool } from "./analyticsToolNames.js";

describe("ANALYTICS_TOOL_NAMES (chart default-deny allowlist)", () => {
  it("is exactly the three analytics tools", () => {
    expect([...ANALYTICS_TOOL_NAMES].sort()).toEqual(
      ["get_bid_award_variance", "get_pipeline_summary", "list_deals"].sort()
    );
  });

  it("admits the analytics tools", () => {
    expect(isAnalyticsTool("get_pipeline_summary")).toBe(true);
    expect(isAnalyticsTool("list_deals")).toBe(true);
    expect(isAnalyticsTool("get_bid_award_variance")).toBe(true);
  });

  it("EXCLUDES describe_capabilities and both email tools (PII never chartable)", () => {
    expect(isAnalyticsTool("describe_capabilities")).toBe(false);
    expect(isAnalyticsTool("list_email_threads")).toBe(false);
    expect(isAnalyticsTool("get_email_thread")).toBe(false);
    expect(isAnalyticsTool("")).toBe(false);
  });
});
