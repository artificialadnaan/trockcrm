import { describe, expect, it } from "vitest";
import {
  buildDuplicateCompanyClusters,
  normalizeCompanyNameForDuplicateDetection,
} from "../../../scripts/detect-duplicate-companies";

describe("detect-duplicate-companies", () => {
  it("normalizes punctuation, casing, and corporate suffixes for exact-name matching", () => {
    expect(normalizeCompanyNameForDuplicateDetection(" ACME, Inc. ")).toBe("acme");
    expect(normalizeCompanyNameForDuplicateDetection("Acme LLC")).toBe("acme");
  });

  it("groups likely duplicates by fuzzy name, contact domain, and primary address without auto-merging", () => {
    const clusters = buildDuplicateCompanyClusters([
      {
        id: "company-a",
        name: "Acme Inc.",
        domain: null,
        website: null,
        address: "100 Main St.",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        contactDomains: ["acme.com"],
      },
      {
        id: "company-b",
        name: "ACME",
        domain: null,
        website: null,
        address: "100 Main Street",
        city: "Dallas",
        state: "TX",
        zip: "75201-1234",
        contactDomains: ["acme.com"],
      },
      {
        id: "company-c",
        name: "Different Co",
        domain: null,
        website: null,
        address: "200 Side St",
        city: "Dallas",
        state: "TX",
        zip: "75202",
        contactDomains: ["different.com"],
      },
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      companyIds: ["company-a", "company-b"],
      confidenceScore: 0.99,
    });
    expect(clusters[0].reasons).toEqual(
      expect.arrayContaining(["exact_normalized_name", "same_contact_domain", "same_primary_address"])
    );
  });
});
