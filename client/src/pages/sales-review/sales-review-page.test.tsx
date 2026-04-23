import { describe, expect, it } from "vitest";
import pageSource from "./sales-review-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("SalesReviewPage", () => {
  const source = normalize(pageSource);

  it("wires the weekly review sections into one operational page", () => {
    expect(source).toContain('title="Sales Review"');
    expect(source).toContain("<SalesReviewFilters");
    expect(source).toContain("<SalesReviewForecastTable");
    expect(source).toContain("<SalesReviewActivityCard");
    expect(source).toContain("<SalesReviewHygieneCard");
    expect(source).toContain("<SalesReviewSupportCard");
  });
});
