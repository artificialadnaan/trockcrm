import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(resolve(__dirname, "../../../src/modules/leads/service.ts"), "utf8");

describe("lead detail metadata contract", () => {
  it("decorates lead detail responses with assignedRepName", () => {
    expect(serviceSource).toContain("assignedRepRows");
    expect(serviceSource).toContain("displayName: users.displayName");
    expect(serviceSource).toContain("assignedRepName: assignedRepMap.get(lead.assignedRepId) ?? null");
  });
});
