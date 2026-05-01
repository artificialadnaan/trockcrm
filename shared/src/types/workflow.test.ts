import { describe, expect, it } from "vitest";
import { toCanonicalDealStageSlug } from "./workflow.js";

describe("workflow stage canonicalization", () => {
  it("preserves service-route estimating fallback from the bare estimating slug", () => {
    expect(toCanonicalDealStageSlug("estimating", "service")).toBe("service_estimating");
    expect(toCanonicalDealStageSlug("estimating", "normal")).toBe("estimating");
    expect(toCanonicalDealStageSlug("estimate_in_progress", "service")).toBe("service_estimating");
  });

  it("keeps truly shared stage slugs canonical for both workflow routes", () => {
    for (const slug of ["estimate_under_review", "estimate_sent_to_client", "contract", "won", "lost"]) {
      expect(toCanonicalDealStageSlug(slug, "normal")).toBe(slug);
      expect(toCanonicalDealStageSlug(slug, "service")).toBe(slug);
    }
  });
});
