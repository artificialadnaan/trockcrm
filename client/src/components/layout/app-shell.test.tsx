import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("AppShell mounts the usage tracker", () => {
  it("calls usePlatformUsageTracker once", () => {
    const src = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");
    expect(src).toContain("usePlatformUsageTracker");
  });
});
