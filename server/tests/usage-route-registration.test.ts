import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("usage route registration", () => {
  it("mounts /usage in the CRM tenant route policy", () => {
    const policy = readFileSync(new URL("../src/route-access-policy.ts", import.meta.url), "utf8");
    expect(policy).toContain('"/usage"');
  });

  it("wires usageRoutes into app.ts", () => {
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(app).toContain("usageRoutes");
    expect(app).toContain('["/usage", usageRoutes]');
  });
});
