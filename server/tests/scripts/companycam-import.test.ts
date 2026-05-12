import { describe, expect, it } from "vitest";
import { validateCompanyCamImportOptions } from "../../../scripts/companycam-import";

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
});
