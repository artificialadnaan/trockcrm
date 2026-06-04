import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseExportArgs } from "../../../scripts/close-date-export.js";
import { parseReimportArgs, resolveFiles, resolveActorUserId, csvCell } from "../../../scripts/close-date-reimport.js";

/** CLI arg parsing + file/actor resolution for both scripts. */

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
  it("throws on an empty --tenant= (a bad shell expansion must not silently export all offices)", () => {
    expect(() => parseExportArgs(["--tenant="])).toThrow();
  });
  it("throws on an empty --out=", () => {
    expect(() => parseExportArgs(["--out="])).toThrow();
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

describe("resolveFiles (existence checks, fail loud not silent)", () => {
  let dir: string;
  let realFile: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-resolve-"));
    realFile = path.join(dir, "close-dates-alice.xlsx");
    fs.writeFileSync(realFile, "x");
    fs.writeFileSync(path.join(dir, "~$close-dates-bob.xlsx"), "x"); // Excel lock file, ignored
    fs.writeFileSync(path.join(dir, "notes.txt"), "x"); // non-xlsx, ignored
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("throws on a missing --file", () => {
    expect(() => resolveFiles({ file: path.join(dir, "nope.xlsx"), dir: null, mode: "dry-run", overwriteExisting: false })).toThrow(/No such file/);
  });
  it("throws on a missing --dir", () => {
    expect(() => resolveFiles({ file: null, dir: path.join(dir, "nope"), mode: "dry-run", overwriteExisting: false })).toThrow(/No such directory/);
  });
  it("returns the single real --file", () => {
    expect(resolveFiles({ file: realFile, dir: null, mode: "dry-run", overwriteExisting: false })).toEqual([realFile]);
  });
  it("throws when --file is not an .xlsx", () => {
    const txt = path.join(dir, "notes.txt");
    expect(() => resolveFiles({ file: txt, dir: null, mode: "dry-run", overwriteExisting: false })).toThrow(/\.xlsx/);
  });
  it("throws when --file points at a directory", () => {
    expect(() => resolveFiles({ file: dir, dir: null, mode: "dry-run", overwriteExisting: false })).toThrow(/must be a file/);
  });
  it("lists only real .xlsx files in --dir (skips ~$ lock files and non-xlsx)", () => {
    expect(resolveFiles({ file: null, dir, mode: "dry-run", overwriteExisting: false })).toEqual([realFile]);
  });
});

describe("resolveActorUserId", () => {
  it("returns null when the env var is unset", () => {
    expect(resolveActorUserId({} as NodeJS.ProcessEnv)).toBeNull();
  });
  it("returns a valid UUID", () => {
    const id = "00000000-0000-4000-8000-0000000000a1";
    expect(resolveActorUserId({ CLOSE_DATE_ACTOR_USER_ID: id } as NodeJS.ProcessEnv)).toBe(id);
  });
  it("throws on a non-UUID value", () => {
    expect(() => resolveActorUserId({ CLOSE_DATE_ACTOR_USER_ID: "alice" } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("csvCell formula-injection neutralization", () => {
  it("prefixes a leading =,+,-,@ with a single quote so it isn't evaluated", () => {
    expect(csvCell("=1+2")).toBe("'=1+2");
    expect(csvCell("+44")).toBe("'+44");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-cmd")).toBe("'-cmd");
  });
  it("still escapes embedded quotes/commas/newlines and leaves benign text alone", () => {
    expect(csvCell("Acme, Inc")).toBe('"Acme, Inc"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("DFW-1-00001-aa")).toBe("DFW-1-00001-aa");
    expect(csvCell(null)).toBe("");
  });
  it("neutralizes AND quote-wraps when a formula-prefixed value also needs CSV escaping", () => {
    expect(csvCell("=Acme, Inc")).toBe(`"'=Acme, Inc"`); // leading '=' neutralized, comma forces quoting
    expect(csvCell("+1,234")).toBe(`"'+1,234"`);
    expect(csvCell('=say "hi"')).toBe(`"'=say ""hi"""`); // prefix + escaped inner quotes
  });
});
