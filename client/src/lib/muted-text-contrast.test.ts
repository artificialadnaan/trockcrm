import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// `text-slate-400` ON A LIGHT BACKGROUND IS 2.5:1. AA WANTS 4.5.
//
// Measured on production, not derived from the palette:
//
//   /reports/monday-showcase   slate-400 on slate-50 @10px    → 2.45:1
//   /projects/weekly-reports   slate-400 on white   @11.5px   → 2.56:1
//   /companies                 slate-500 on slate-100 @10px   → 4.34:1
//
// The first two are roughly half the contrast WCAG 2.2 SC 1.4.3 requires — on hint text, column captions
// and status meta, which is exactly the text somebody squints at. `slate-500` on white is 4.76:1 and
// clears it; `slate-600` is 7.58:1.
//
// A RATCHET, NOT A RULE, AND DELIBERATELY SO. There are 364 `text-slate-400` usages across 87 files and
// most are FINE: on a dark surface, slate-400 is the correct choice and moving it to slate-500 would make
// contrast WORSE. Static analysis cannot tell which is which — the background usually comes from an
// ancestor — so a blanket rewrite would be a guess dressed as a fix, and a global assertion would fail on
// ~140 sites nobody has measured.
//
// So this pins the count and fails when it GROWS. The sites fixed alongside it are the ones actually
// measured failing in the browser. The rest are a design decision — darkening muted text app-wide changes
// how the product looks — and that belongs to whoever owns the visual system, not to a sweep.
//
// LOWER THIS NUMBER, never raise it. If a change legitimately adds one on a dark surface, say so here.

const CLIENT_SRC = path.resolve(__dirname, "..");

/** Small-text size classes — the sizes where AA demands 4.5:1 rather than 3:1. */
const SMALL_TEXT = /text-\[(?:9|10|11|12)(?:\.\d)?px\]|text-xs/;

/** An icon, not text. Sized targets fall under SC 1.4.11 at 3:1 and are not this file's business. */
const ICON = /\bh-\d(?:\.\d)?\s+w-\d(?:\.\d)?\b|\bsize-\d\b/;

/**
 * The count at the time the measured failures were fixed.
 *
 * Every one of these is `text-slate-400` on small text. Each is a POSSIBLE failure — possible, because
 * whether it fails depends on the background it lands on, which is why they were not swept blindly.
 */
const KNOWN_REMAINING = 142;

function smallSlate400Sites(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) continue;
      fs.readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (!line.includes("text-slate-400")) return;
          if (!SMALL_TEXT.test(line)) return;
          if (ICON.test(line)) return;
          found.push(`${path.relative(CLIENT_SRC, full)}:${index + 1}`);
        });
    }
  };
  walk(CLIENT_SRC);
  return found;
}

describe("muted text does not get quieter", () => {
  it("finds the sites at all — an empty sweep would make the ratchet meaningless", () => {
    // The standing failure of a counting guard: the scan breaks, the count drops to zero, and it reads as
    // an improvement. A floor is as important as the ceiling.
    expect(smallSlate400Sites().length).toBeGreaterThan(50);
  });

  it("does not add new small-text slate-400, which is 2.5:1 on a light background", () => {
    const sites = smallSlate400Sites();
    expect(
      sites.length,
      sites.length > KNOWN_REMAINING
        ? `${sites.length - KNOWN_REMAINING} new small-text text-slate-400 site(s). On a light background ` +
          "that is ~2.5:1 against a 4.5:1 requirement — use text-slate-500 (4.76:1) unless this sits on a " +
          "dark surface, in which case lower KNOWN_REMAINING and say so."
        : "",
    ).toBeLessThanOrEqual(KNOWN_REMAINING);
  });

  it("keeps the recorded baseline honest when sites are removed", () => {
    // The ratchet only ratchets if the number tracks reality. Drifting far below means somebody fixed a
    // batch and left the constant behind, and the guard silently stops catching the next regression.
    const sites = smallSlate400Sites();
    expect(
      sites.length,
      `KNOWN_REMAINING is ${KNOWN_REMAINING} but only ${sites.length} sites remain — lower the constant.`,
    ).toBeGreaterThan(KNOWN_REMAINING - 10);
  });

  it("leaves the audited pages clean, which is what was actually verified", () => {
    // The three files whose failures were measured in the browser. Everything else is a count; these are a
    // claim, so they are asserted rather than trusted to the ratchet.
    const audited = [
      "pages/projects/weekly-reports-page.tsx",
      "pages/reports/monday-showcase/variants.tsx",
      "pages/reports/region-report-page.tsx",
    ];
    const dirty = smallSlate400Sites().filter((site) =>
      audited.some((file) => site.startsWith(file)),
    );
    expect(dirty, "these audited files still carry small-text slate-400").toEqual([]);
  });
});
