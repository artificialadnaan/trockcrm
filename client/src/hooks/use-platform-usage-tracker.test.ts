import { describe, expect, it } from "vitest";
import { shouldSendHeartbeat, classifyRoute } from "./use-platform-usage-tracker";

describe("shouldSendHeartbeat", () => {
  it("sends when visible and recently interacted", () => {
    expect(shouldSendHeartbeat({ visibility: "visible", msSinceInteraction: 1000, idleMs: 300_000 })).toBe(true);
  });
  it("does not send when tab hidden", () => {
    expect(shouldSendHeartbeat({ visibility: "hidden", msSinceInteraction: 1000, idleMs: 300_000 })).toBe(false);
  });
  it("does not send after the idle threshold", () => {
    expect(shouldSendHeartbeat({ visibility: "visible", msSinceInteraction: 400_000, idleMs: 300_000 })).toBe(false);
  });
  it("does not send when msSinceInteraction equals the idle threshold (boundary — gate is strict <)", () => {
    expect(shouldSendHeartbeat({ visibility: "visible", msSinceInteraction: 300_000, idleMs: 300_000 })).toBe(false);
  });
});

describe("classifyRoute", () => {
  it("classifies deal, lead, report, and generic pages", () => {
    expect(classifyRoute("/deals/00000000-0000-4000-8000-000000000001").entityType).toBe("deal");
    expect(classifyRoute("/leads/00000000-0000-4000-8000-000000000001").entityType).toBe("lead");
    expect(classifyRoute("/reports/performance/platform-usage").entityType).toBe("report");
    expect(classifyRoute("/pipeline").entityType).toBe("page");
  });
});
