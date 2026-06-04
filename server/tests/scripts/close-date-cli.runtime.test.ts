import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseExportArgs } from "../../../scripts/close-date-export.js";
import { parseReimportArgs, resolveFiles, resolveActorUserId } from "../../../scripts/close-date-reimport.js";

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
