import { describe, expect, it, vi } from "vitest";
import {
  classifyDirectoryMatch,
  normalizeDirectoryName,
  normalizeEmailDomain,
  normalizeZip,
  scanDirectoryDuplicates,
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

  it("skips a pair when another scan already holds its advisory lock", async () => {
    const companyRows = [
      { id: "company-a", name: "Acme Apartments LLC", state: "TX", zip: "75201", isActive: true },
      { id: "company-b", name: "ACME Apartments", state: "TX", zip: "75201-4421", isActive: true },
    ];
    const tenantDb = createTenantDbForScan(companyRows, [{ rows: [{ locked: true }] }, { rows: [{ locked: false }] }]);

    const first = await scanDirectoryDuplicates(tenantDb as any, { autoMerge: true });
    const second = await scanDirectoryDuplicates(tenantDb as any, { autoMerge: true });

    expect(first.autoMerged).toBe(1);
    expect(second.autoMerged).toBe(0);
    expect(tenantDb.update).toHaveBeenCalledTimes(3);
    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
  });
});

function createTenantDbForScan(companyRows: any[], lockResults: Array<{ rows: Array<{ locked: boolean }> }>) {
  const selectQueue = [companyRows, [], companyRows, []];
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  return {
    execute: vi.fn().mockImplementation(async () => lockResults.shift() ?? { rows: [{ locked: true }] }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(selectQueue.shift() ?? []),
        })),
      })),
    })),
    update,
    insert,
  };
}
