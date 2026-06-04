import { describe, expect, it } from "vitest";
import {
  parseCompanyCamImportArgs,
  prepareCompanyCamImportRows,
  validateCompanyCamImportOptions,
  validateCompanyCamMatchConflicts,
} from "../../../scripts/companycam-import";
import type { CompanyCamImportPlanRow } from "../../../scripts/companycam-inventory";

function planRow(overrides: Partial<CompanyCamImportPlanRow>): CompanyCamImportPlanRow {
  return {
    companyCamProjectId: "cc-default",
    companyCamProjectName: "Default",
    photoCount: 1,
    matchedDealId: "deal-default",
    matchedDealName: "Default Deal",
    matchedDealNumber: "D-1",
    confidence: 1,
    matchReason: "exact_unique_name", // a reliable (auto) tier so the one-to-one dedup engages
    ...overrides,
  };
}

describe("companycam-import", () => {
  it("blocks unscoped execute runs unless bulk execution is explicit", () => {
    expect(() =>
      validateCompanyCamImportOptions({ tenant: "office_dallas", execute: true, allowBulkExecute: false })
    ).toThrow(/--execute requires/);

    expect(() =>
      validateCompanyCamImportOptions({ tenant: "office_dallas", execute: true, allowBulkExecute: false, projectId: "cc-1" })
    ).not.toThrow();

    expect(() =>
      validateCompanyCamImportOptions({ tenant: "office_dallas", execute: true, allowBulkExecute: false, limit: 1 })
    ).not.toThrow();

    expect(() =>
      validateCompanyCamImportOptions({ tenant: "office_dallas", execute: true, allowBulkExecute: true })
    ).not.toThrow();
  });

  it("rejects non-positive and non-integer limits before import work starts", () => {
    for (const limit of [-1, 0, Number.NaN, 1.5]) {
      expect(() =>
        validateCompanyCamImportOptions({ tenant: "office_dallas", execute: true, allowBulkExecute: false, limit })
      ).toThrow(/--limit must be a positive integer/);
    }
    for (const rawLimit of ["-1", "0", "abc", "1.5"]) {
      expect(() => parseCompanyCamImportArgs(["--execute", `--limit=${rawLimit}`])).toThrow(
        new RegExp(`--limit must be a positive integer \\(got ${rawLimit.replace(".", "\\.")}\\)`)
      );
    }

    expect(() =>
      validateCompanyCamImportOptions({ tenant: "office_dallas", execute: true, allowBulkExecute: false, limit: 1 })
    ).not.toThrow();
    expect(() =>
      validateCompanyCamImportOptions({ tenant: "office_dallas", execute: true, allowBulkExecute: false, limit: 10 })
    ).not.toThrow();
    expect(parseCompanyCamImportArgs(["--execute", "--limit=1"]).limit).toBe(1);
    expect(parseCompanyCamImportArgs(["--execute", "--limit=10"]).limit).toBe(10);
  });

  it("keeps only the highest-confidence CompanyCam project for each matched deal", () => {
    const result = prepareCompanyCamImportRows([
      planRow({ companyCamProjectId: "cc-low", companyCamProjectName: "Lower", matchedDealId: "deal-1", confidence: 0.91 }),
      planRow({ companyCamProjectId: "cc-high", companyCamProjectName: "Higher", matchedDealId: "deal-1", confidence: 0.99 }),
      planRow({ companyCamProjectId: "cc-other", matchedDealId: "deal-2", confidence: 0.95 }),
    ]);

    expect(result.rows.map((row) => row.companyCamProjectId)).toEqual(["cc-high", "cc-other"]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        droppedCompanyCamProjectId: "cc-low",
        keptCompanyCamProjectId: "cc-high",
        matchedDealId: "deal-1",
      }),
    ]);
  });

  it("refuses strict one-to-one imports when duplicate project matches exist", () => {
    const result = prepareCompanyCamImportRows([
      planRow({ companyCamProjectId: "cc-a", matchedDealId: "deal-1", confidence: 0.91 }),
      planRow({ companyCamProjectId: "cc-b", matchedDealId: "deal-1", confidence: 0.99 }),
    ]);

    expect(() =>
      validateCompanyCamMatchConflicts(result.conflicts, { execute: true, strictOneToOne: true })
    ).toThrow(/duplicate CompanyCam deal matches/);
    expect(() =>
      validateCompanyCamMatchConflicts(result.conflicts, { execute: true, strictOneToOne: false })
    ).not.toThrow();
  });

  it("detects one-to-one conflicts even when importing a single project", () => {
    const result = prepareCompanyCamImportRows(
      [
        planRow({ companyCamProjectId: "cc-low", matchedDealId: "deal-1", confidence: 0.91 }),
        planRow({ companyCamProjectId: "cc-high", matchedDealId: "deal-1", confidence: 0.99 }),
      ],
      { projectId: "cc-low" }
    );

    expect(result.rows).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        droppedCompanyCamProjectId: "cc-low",
        keptCompanyCamProjectId: "cc-high",
      }),
    ]);
  });

  it("auto-seeds only the reliable (auto) tiers — skips fuzzy, on-hold, and unmatched", () => {
    const result = prepareCompanyCamImportRows([
      planRow({ companyCamProjectId: "cc-link", matchReason: "existing_companycam_link", matchedDealId: "d1" }),
      planRow({ companyCamProjectId: "cc-num", matchReason: "project_number_in_name", matchedDealId: "d2" }),
      planRow({ companyCamProjectId: "cc-exact", matchReason: "exact_unique_name", matchedDealId: "d3" }),
      planRow({ companyCamProjectId: "cc-fuzzy", matchReason: "fuzzy_project_name", matchedDealId: "d4", confidence: 0.95 }), // sub/ambiguous -> manual
      planRow({ companyCamProjectId: "cc-onhold", matchReason: "exact_unique_name", matchedDealId: "d5", matchedDealOnHold: true }), // on-hold -> manual
      planRow({ companyCamProjectId: "cc-unmatched", matchReason: "unmatched", matchedDealId: null, confidence: 0 }), // unmatched -> manual
    ]);

    expect(result.rows.map((row) => row.companyCamProjectId).sort()).toEqual(["cc-exact", "cc-link", "cc-num"]);
    expect(result.conflicts).toEqual([]); // each kept project maps to a distinct deal
  });
});
