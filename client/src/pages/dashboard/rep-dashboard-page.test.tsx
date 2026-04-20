import { describe, expect, it } from "vitest";
import pageSource from "./rep-dashboard-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("RepDashboardPage", () => {
  const source = normalize(pageSource);

  it("surfaces the rep cleanup queue from the dashboard", () => {
    expect(source).toContain('import { useSalesReview } from "@/hooks/use-sales-review";');
    expect(source).toContain("My Cleanup");
    expect(source).toContain('navigate("/pipeline/hygiene")');
    expect(source).toContain("Active Leads");
    expect(source).toContain("Today At A Glance");
    expect(source).toContain("Leads Snapshot");
    expect(source).toContain("Deals Snapshot");
    expect(source).toContain("10 at a time");
  });
});
