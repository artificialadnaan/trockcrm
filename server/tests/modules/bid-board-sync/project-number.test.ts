import { describe, expect, it } from "vitest";

import {
  canonicalizeProjectNumber,
  canonicalProjectNumberSql,
} from "../../../src/modules/bid-board-sync/project-number.js";

// Explicit code points so the test provably exercises the intended characters.
const HYPHEN = "‐";
const NB_HYPHEN = "‑";
const FIGURE_DASH = "‒";
const EN_DASH = "–";
const EM_DASH = "—";
const HORIZONTAL_BAR = "―";
const NBSP = " ";
const E_COMPOSED = "café-1"; // é = U+00E9
const E_DECOMPOSED = "café-1"; // e + combining acute U+0301

describe("canonicalizeProjectNumber", () => {
  it("lowercases (case-insensitive matching)", () => {
    expect(canonicalizeProjectNumber("DFW-4-11826-AB")).toBe("dfw-4-11826-ab");
  });

  it("trims surrounding ASCII whitespace (space, tab, newline, CR) — matched by the SQL btrim set", () => {
    expect(canonicalizeProjectNumber("  DFW-4-11826-ab  ")).toBe("dfw-4-11826-ab");
    expect(canonicalizeProjectNumber("\tDFW-4-11826-ab\t")).toBe("dfw-4-11826-ab");
    expect(canonicalizeProjectNumber("\nDFW-4-11826-ab\r\n")).toBe("dfw-4-11826-ab");
    expect(canonicalizeProjectNumber("\f\vDFW-4-11826-ab\v\f")).toBe("dfw-4-11826-ab");
  });

  it("folds the full Unicode dash range U+2010..U+2015 to an ASCII hyphen", () => {
    expect(canonicalizeProjectNumber(`DFW${HYPHEN}4${NB_HYPHEN}11826${FIGURE_DASH}ab`)).toBe(
      "dfw-4-11826-ab"
    );
    expect(canonicalizeProjectNumber(`DFW${EN_DASH}4${EM_DASH}11826${HORIZONTAL_BAR}ab`)).toBe(
      "dfw-4-11826-ab"
    );
  });

  it("treats an en/em-dash variant as identical to the ASCII-hyphen value", () => {
    expect(canonicalizeProjectNumber(`DFW${EN_DASH}4${EM_DASH}11826${EN_DASH}ab`)).toBe(
      canonicalizeProjectNumber("DFW-4-11826-ab")
    );
  });

  it("strips non-breaking spaces (U+00A0) anywhere in the value", () => {
    expect(canonicalizeProjectNumber(`DFW-4-11826-ab${NBSP}`)).toBe("dfw-4-11826-ab");
    expect(canonicalizeProjectNumber(`${NBSP}DFW-4-11826-ab`)).toBe("dfw-4-11826-ab");
    expect(canonicalizeProjectNumber(`DFW-4${NBSP}-11826-ab`)).toBe("dfw-4-11826-ab");
  });

  it("preserves the internal separator structure (does NOT collapse like the status normalizer)", () => {
    // Guards against reusing normalizeBidBoardStatus, which collapses [_-]+ to spaces.
    expect(canonicalizeProjectNumber("DFW-4-11826-ab")).toBe("dfw-4-11826-ab");
    expect(canonicalizeProjectNumber("DFW_4_11826_ab")).toBe("dfw_4_11826_ab");
  });

  it("does NOT false-positive on a genuinely different suffix (Duneville ai vs ab)", () => {
    expect(canonicalizeProjectNumber("DFW-4-11826-ai")).not.toBe(
      canonicalizeProjectNumber("DFW-4-11826-ab")
    );
  });

  it("NFC-normalizes composed/decomposed equivalents", () => {
    expect(canonicalizeProjectNumber(E_DECOMPOSED)).toBe(canonicalizeProjectNumber(E_COMPOSED));
    expect(canonicalizeProjectNumber(E_DECOMPOSED)).toBe(E_COMPOSED.toLowerCase());
  });

  it("returns null for nullish / empty / whitespace-only / NBSP-only input", () => {
    expect(canonicalizeProjectNumber(null)).toBeNull();
    expect(canonicalizeProjectNumber(undefined)).toBeNull();
    expect(canonicalizeProjectNumber("")).toBeNull();
    expect(canonicalizeProjectNumber("   ")).toBeNull();
    expect(canonicalizeProjectNumber("\t")).toBeNull();
    expect(canonicalizeProjectNumber(NBSP)).toBeNull();
  });
});

describe("canonicalProjectNumberSql", () => {
  it("builds a SQL expression that mirrors canonicalizeProjectNumber for a column", () => {
    const sql = canonicalProjectNumberSql("d.project_number");
    expect(sql).toContain("lower(");
    expect(sql).toContain("btrim(");
    expect(sql).toContain("translate(");
    expect(sql).toContain("normalize(d.project_number, NFC)");
    // The six Unicode dashes map to '-'; NBSP (U+00A0) has no target char and is deleted.
    expect(sql).toContain("'------'");
    expect(sql).toContain("\\u2010");
    expect(sql).toContain("\\u00a0");
    // btrim strips the same ASCII whitespace set as the TS regex (space/tab/LF/VT/FF/CR)
    expect(sql).toContain("chr(32)||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)");
  });

  it("interpolates the provided column expression verbatim", () => {
    expect(canonicalProjectNumberSql("d.bid_board_project_number")).toContain(
      "normalize(d.bid_board_project_number, NFC)"
    );
  });
});
