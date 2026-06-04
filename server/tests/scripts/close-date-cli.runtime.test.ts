import { describe, expect, it } from "vitest";
import { parseExportArgs } from "../../../scripts/close-date-export.js";
import { parseReimportArgs } from "../../../scripts/close-date-reimport.js";

/** CLI arg parsing for both scripts (pure, no DB / no IO). */

describe("parseExportArgs", () => {
  it("defaults: all tenants, no out override, write mode (not dry-run)", () => {
    expect(parseExportArgs([])).toEqual({ tenant: null, outDir: null, dryRun: false });
  });
  it("--tenant=all is treated as all tenants (null)", () => {
    expect(parseExportArgs(["--tenant=all"]).tenant).toBeNull();
  });
  it("--tenant=<slug> restricts to one tenant", () => {
    expect(parseExportArgs(["--tenant=office_dallas"]).tenant).toBe("office_dallas");
  });
  it("--out and --dry-run are parsed", () => {
    const args = parseExportArgs(["--out=/tmp/x", "--dry-run"]);
    expect(args.outDir).toBe("/tmp/x");
    expect(args.dryRun).toBe(true);
  });
});

describe("parseReimportArgs", () => {
  it("defaults to dry-run, no overwrite", () => {
    expect(parseReimportArgs(["--file=a.xlsx"])).toEqual({
      file: "a.xlsx",
      dir: null,
      mode: "dry-run",
      overwriteExisting: false,
    });
  });
  it("--commit switches to commit mode", () => {
    expect(parseReimportArgs(["--dir=./filled", "--commit"]).mode).toBe("commit");
  });
  it("--overwrite-existing opts into clobbering", () => {
    expect(parseReimportArgs(["--file=a.xlsx", "--overwrite-existing"]).overwriteExisting).toBe(true);
  });
  it("throws when neither --file nor --dir is given", () => {
    expect(() => parseReimportArgs([])).toThrow();
  });
  it("throws when BOTH --file and --dir are given (ambiguous)", () => {
    expect(() => parseReimportArgs(["--file=a.xlsx", "--dir=./filled"])).toThrow();
  });
});
