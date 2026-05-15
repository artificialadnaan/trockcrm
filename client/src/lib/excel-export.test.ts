import { describe, expect, it } from "vitest";
import { excelDateSerial } from "./excel-export";

describe("excelDateSerial", () => {
  it("treats date-only values as UTC calendar days", () => {
    expect(excelDateSerial(new Date("2026-05-01"))).toBe(46143);
  });

  it("ignores local timezone offsets when the instant lands on a different local day", () => {
    expect(excelDateSerial(new Date("2026-05-01T00:00:00-05:00"))).toBe(46143);
    expect(excelDateSerial(new Date("2026-05-01T23:59:59-05:00"))).toBe(46144);
  });
});
