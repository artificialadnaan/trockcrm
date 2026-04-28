import { describe, expect, it } from "vitest";
import {
  classifyDirectoryMatch,
  normalizeDirectoryName,
  normalizeEmailDomain,
  normalizeZip,
} from "../../src/services/directoryDedup.js";

describe("directory dedup matching", () => {
  it("normalizes company names and ZIP codes for exact matching", () => {
    expect(normalizeDirectoryName("  T-Rock Construction, LLC ")).toBe("t rock construction");
    expect(normalizeZip("75201-1234")).toBe("75201");
  });

  it("auto-merges exact normalized company name and ZIP matches", () => {
    const match = classifyDirectoryMatch({
      kind: "company",
      left: { name: "Acme Apartments LLC", state: "TX", zip: "75201" },
      right: { name: "ACME Apartments", state: "TX", zip: "75201-4421" },
    });

    expect(match.band).toBe("auto_merge");
    expect(match.score).toBeGreaterThanOrEqual(0.95);
    expect(match.reasons).toContain("exact_normalized_name_zip");
  });

  it("queues fuzzy company matches within the same state", () => {
    const match = classifyDirectoryMatch({
      kind: "company",
      left: { name: "North Dallas Industrial Center", state: "TX", zip: "75001" },
      right: { name: "North Dallas Industrial Cntr", state: "TX", zip: "75002" },
    });

    expect(match.band).toBe("review_queue");
    expect(match.score).toBeGreaterThanOrEqual(0.8);
    expect(match.score).toBeLessThan(0.95);
    expect(match.reasons).toContain("fuzzy_name_same_state");
  });

  it("uses contact email domains as a review signal", () => {
    expect(normalizeEmailDomain("Owner@Example.COM")).toBe("example.com");

    const match = classifyDirectoryMatch({
      kind: "contact",
      left: { firstName: "Sam", lastName: "Owner", email: "sam@example.com", state: "TX" },
      right: { firstName: "Samuel", lastName: "Owner", email: "samuel@example.com", state: "TX" },
    });

    expect(match.band).toBe("review_queue");
    expect(match.reasons).toContain("domain_match");
  });

  it("ignores weak cross-state fuzzy matches", () => {
    const match = classifyDirectoryMatch({
      kind: "company",
      left: { name: "North Dallas Industrial Center", state: "TX", zip: "75001" },
      right: { name: "North Dallas Industrial Cntr", state: "OK", zip: "73001" },
    });

    expect(match.band).toBe("none");
  });
});
