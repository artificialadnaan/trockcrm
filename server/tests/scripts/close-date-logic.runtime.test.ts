import { describe, expect, it } from "vitest";
import {
  parseExpectedCloseDate,
  classifyImportRow,
  repFileSlug,
  groupDealsByRep,
  type MissingCloseDateDeal,
} from "../../../scripts/lib/close-date-workflow.js";

/**
 * Pure-logic unit coverage for the close-date export/re-import workflow.
 * Lives in the *.runtime.test.ts lane so `npm run test:runtime` (the CI premerge gate)
 * executes it. No database here — see close-date-export / close-date-reimport runtime
 * tests for the PGlite-backed SQL behaviors.
 */

describe("parseExpectedCloseDate", () => {
  it("treats null / undefined / empty / whitespace as BLANK (no intent to write)", () => {
    expect(parseExpectedCloseDate(null).status).toBe("blank");
    expect(parseExpectedCloseDate(undefined).status).toBe("blank");
    expect(parseExpectedCloseDate("").status).toBe("blank");
    expect(parseExpectedCloseDate("   ").status).toBe("blank");
  });

  it("parses an ISO YYYY-MM-DD string", () => {
    expect(parseExpectedCloseDate("2026-09-15")).toEqual({ status: "ok", value: "2026-09-15" });
  });

  it("parses a US M/D/YYYY string and zero-pads", () => {
    expect(parseExpectedCloseDate("9/5/2026")).toEqual({ status: "ok", value: "2026-09-05" });
    expect(parseExpectedCloseDate("12/31/2026")).toEqual({ status: "ok", value: "2026-12-31" });
  });

  it("parses a JS Date using its UTC calendar day (exceljs serial-date materialization)", () => {
    expect(parseExpectedCloseDate(new Date(Date.UTC(2026, 8, 15)))).toEqual({
      status: "ok",
      value: "2026-09-15",
    });
  });

  it("parses an Excel serial number to the right calendar date", () => {
    // 46280 == 2026-09-15 (days since 1899-12-30 epoch)
    expect(parseExpectedCloseDate(46280)).toEqual({ status: "ok", value: "2026-09-15" });
  });

  it("rejects an impossible calendar date as INVALID", () => {
    expect(parseExpectedCloseDate("2026-02-30").status).toBe("invalid");
    expect(parseExpectedCloseDate("13/40/2026").status).toBe("invalid");
  });

  it("rejects out-of-range years and unparseable junk as INVALID", () => {
    expect(parseExpectedCloseDate("1999-01-01").status).toBe("invalid");
    expect(parseExpectedCloseDate("2200-01-01").status).toBe("invalid");
    expect(parseExpectedCloseDate("next quarter").status).toBe("invalid");
    expect(parseExpectedCloseDate(true).status).toBe("invalid");
  });

  it("accepts a US 2-digit year and pivots into 2000-2099", () => {
    expect(parseExpectedCloseDate("9/15/26")).toEqual({ status: "ok", value: "2026-09-15" });
    expect(parseExpectedCloseDate("1/1/00")).toEqual({ status: "ok", value: "2000-01-01" });
    expect(parseExpectedCloseDate("12/31/99")).toEqual({ status: "ok", value: "2099-12-31" });
  });

  it("truncates an Excel serial that carries a time fraction to its calendar day (no round-up)", () => {
    expect(parseExpectedCloseDate(46280.6)).toEqual({ status: "ok", value: "2026-09-15" });
  });

  it("rejects mixed separators (the two separators must match)", () => {
    expect(parseExpectedCloseDate("9-5/2026").status).toBe("invalid");
    expect(parseExpectedCloseDate("2026/9-15").status).toBe("invalid");
  });
});

describe("classifyImportRow (safe-default: never clobber, flag conflicts)", () => {
  const ok = (value: string) => ({ status: "ok", value }) as const;

  it("BLANK date is skipped before anything else", () => {
    expect(
      classifyImportRow({ parsed: { status: "blank" }, keyValid: true, found: true, existing: null, overwriteExisting: false }).outcome,
    ).toBe("SKIPPED_BLANK");
  });

  it("INVALID date is reported (a filled-but-bad value), not silently dropped", () => {
    expect(
      classifyImportRow({ parsed: { status: "invalid", reason: "x" }, keyValid: true, found: true, existing: null, overwriteExisting: false }).outcome,
    ).toBe("INVALID_DATE");
  });

  it("INVALID key (tampered/corrupt UUID or unknown office) is reported", () => {
    expect(
      classifyImportRow({ parsed: ok("2026-09-15"), keyValid: false, found: false, existing: null, overwriteExisting: false }).outcome,
    ).toBe("INVALID_KEY");
  });

  it("UNMATCHED when the deal is not found", () => {
    expect(
      classifyImportRow({ parsed: ok("2026-09-15"), keyValid: true, found: false, existing: null, overwriteExisting: false }).outcome,
    ).toBe("UNMATCHED");
  });

  it("WRITTEN when the deal currently has no expected close date", () => {
    const r = classifyImportRow({ parsed: ok("2026-09-15"), keyValid: true, found: true, existing: null, overwriteExisting: false });
    expect(r.outcome).toBe("WRITTEN");
    expect(r.writeValue).toBe("2026-09-15");
  });

  it("NOOP (idempotent) when the existing date already equals the sheet date", () => {
    const r = classifyImportRow({ parsed: ok("2026-09-15"), keyValid: true, found: true, existing: "2026-09-15", overwriteExisting: false });
    expect(r.outcome).toBe("NOOP");
    expect(r.writeValue).toBeNull();
  });

  it("CONFLICT (skipped) when an existing date differs and overwrite is OFF", () => {
    const r = classifyImportRow({ parsed: ok("2026-09-15"), keyValid: true, found: true, existing: "2026-01-01", overwriteExisting: false });
    expect(r.outcome).toBe("CONFLICT");
    expect(r.writeValue).toBeNull();
  });

  it("OVERWRITTEN only when an existing date differs AND overwrite is explicitly ON", () => {
    const r = classifyImportRow({ parsed: ok("2026-09-15"), keyValid: true, found: true, existing: "2026-01-01", overwriteExisting: true });
    expect(r.outcome).toBe("OVERWRITTEN");
    expect(r.writeValue).toBe("2026-09-15");
  });
});

describe("repFileSlug", () => {
  it("slugifies a display name to filesystem-safe lowercase-dashed", () => {
    expect(repFileSlug("Caleb O'Brien")).toBe("caleb-o-brien");
    expect(repFileSlug("  Derek   Smith  ")).toBe("derek-smith");
  });
  it("falls back to 'unassigned' when the name slugs to empty", () => {
    expect(repFileSlug("***")).toBe("unassigned");
    expect(repFileSlug("Unassigned")).toBe("unassigned");
  });
});

describe("groupDealsByRep", () => {
  const deal = (over: Partial<MissingCloseDateDeal>): MissingCloseDateDeal => ({
    tenantSchema: "office_dallas",
    dealId: "00000000-0000-4000-8000-000000000001",
    dealNumber: "DFW-1-00001-aa",
    dealName: "Deal",
    companyName: null,
    stageName: "Estimating",
    estimatedValue: null,
    assignedRepId: "00000000-0000-4000-8000-0000000000a1",
    repName: "Alice",
    ...over,
  });

  it("produces one group per rep containing only that rep's deals", () => {
    const groups = groupDealsByRep([
      deal({ dealId: "d1", assignedRepId: "a1", repName: "Alice" }),
      deal({ dealId: "d2", assignedRepId: "b1", repName: "Bob" }),
      deal({ dealId: "d3", assignedRepId: "a1", repName: "Alice" }),
    ]);
    const alice = groups.find((g) => g.repName === "Alice")!;
    const bob = groups.find((g) => g.repName === "Bob")!;
    expect(alice.deals.map((d) => d.dealId).sort()).toEqual(["d1", "d3"]);
    expect(bob.deals.map((d) => d.dealId)).toEqual(["d2"]);
    expect(alice.fileSlug).toBe("alice");
  });

  it("buckets NULL-rep deals into a single Unassigned group", () => {
    const groups = groupDealsByRep([
      deal({ dealId: "d1", assignedRepId: null, repName: "Unassigned" }),
      deal({ dealId: "d2", assignedRepId: null, repName: "Unassigned" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].repName).toBe("Unassigned");
    expect(groups[0].assignedRepId).toBeNull();
    expect(groups[0].deals).toHaveLength(2);
  });

  it("disambiguates two distinct reps that share a display name (slug collision)", () => {
    const groups = groupDealsByRep([
      deal({ dealId: "d1", assignedRepId: "aaaaaaaa-0000-4000-8000-000000000001", repName: "John Smith" }),
      deal({ dealId: "d2", assignedRepId: "bbbbbbbb-0000-4000-8000-000000000002", repName: "John Smith" }),
    ]);
    expect(groups).toHaveLength(2);
    const slugs = groups.map((g) => g.fileSlug);
    expect(new Set(slugs).size).toBe(2); // no collision
    expect(slugs.every((s) => s.startsWith("john-smith"))).toBe(true);
  });
});
