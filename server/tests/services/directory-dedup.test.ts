import { describe, expect, it, vi } from "vitest";
import { companies } from "@trock-crm/shared/schema";
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

    // Lock acquired on the first scan -> exactly one auto-merge; the second scan
    // fails to acquire the lock -> zero. (The merge now re-points the full
    // reference map, so it issues many updates; we assert it ran at all, plus the
    // two lock attempts.)
    expect(first.autoMerged).toBe(1);
    expect(second.autoMerged).toBe(0);
    expect(tenantDb.update).toHaveBeenCalled();
    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
  });
});

function createTenantDbForScan(companyRows: any[], lockResults: Array<{ rows: Array<{ locked: boolean }> }>) {
  // The bulk company/contact scans use .limit(); the merge's winner/loser fetch
  // uses .limit(1); the merge's moved-row captures await .where() directly. The
  // chain below serves all three: .where() is a thenable (capture -> [] moved
  // rows) that also exposes .limit().
  let companyByIdFetches = 0;
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => {
      const result: any = Promise.resolve(undefined);
      result.onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      return result;
    }),
  }));

  const select = vi.fn(() => {
    let currentTable: unknown;
    const chain: any = {
      from: vi.fn((table: unknown) => {
        currentTable = table;
        return chain;
      }),
      where: vi.fn(() => ({
        then: (resolve: (rows: unknown) => unknown) => resolve([]),
        limit: vi.fn((n: number) => {
          if (currentTable === companies) {
            if (n === 1) {
              const row = companyRows[companyByIdFetches] ?? companyRows[companyRows.length - 1];
              companyByIdFetches += 1;
              return Promise.resolve([row]);
            }
            return Promise.resolve(companyRows);
          }
          return Promise.resolve([]);
        }),
      })),
    };
    return chain;
  });

  return {
    execute: vi.fn().mockImplementation(async () => lockResults.shift() ?? { rows: [{ locked: true }] }),
    select,
    update,
    insert,
  };
}
