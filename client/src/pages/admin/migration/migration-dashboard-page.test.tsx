import { describe, expect, it } from "vitest";
import pageSource from "./migration-dashboard-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("MigrationDashboardPage", () => {
  const source = normalize(pageSource);

  it("adds the ownership seeding workspace to migration", () => {
    expect(source).toContain("Ownership Seeding And Cleanup");
    expect(source).toContain("Preview Sync");
    expect(source).toContain("Apply Sync");
    expect(source).toContain("Assign owner");
    expect(source).toContain('to="/pipeline/hygiene"');
  });
});
