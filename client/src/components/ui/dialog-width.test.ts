import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { twMerge } from "tailwind-merge";

// A DIALOG THAT ASKS FOR A WIDTH AND SILENTLY DOES NOT GET IT.
//
// `DialogContent` pins `sm:max-w-sm` in its base classes. tailwind-merge treats a BREAKPOINT-PREFIXED
// utility and an unprefixed one as different groups, so a caller passing `max-w-5xl` does not replace it —
// both survive, and at the `sm` breakpoint and above the base wins. Every desktop renders that dialog at
// 384px, which is 37% of the width its author asked for.
//
// It is worse than a clamp. The unprefixed caller class DOES replace `max-w-[calc(100%-2rem)]`, which is
// the mobile inset, so an affected dialog is simultaneously too narrow on a laptop and edge-to-edge on a
// phone. Both wrong, in opposite directions, from one line.
//
// NOTHING FAILS WHEN THIS HAPPENS. There is no error, no warning, and the dialog still opens — it is only
// visible to someone who knows what width was requested and measures what arrived. Nine call sites in this
// codebase already carry a `!max-w-*` escape hatch, which is what hitting this and patching locally looks
// like; none of them fixed the mechanism, so the next author walked into it again.
//
// THE FIX IS `sm:` ON THE CALLER, NOT `!important`. A prefixed utility lands in the same tailwind-merge
// group as the base and replaces it cleanly, and it leaves the mobile inset intact. The escape hatch works
// by brute force and leaves the losing class in the markup.
//
// This asserts the OUTCOME by running the real merge over the real source, rather than checking that
// authors remembered a convention.

const CLIENT_SRC = path.resolve(__dirname, "../..");

/** The base class string a primitive applies before the caller's. Read from source so it cannot drift. */
function baseClassesOf(file: string, marker: string): string {
  const source = fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");
  const at = source.indexOf(marker);
  expect(at, `${marker} not found in ${file} — the primitive moved`).toBeGreaterThan(-1);
  // Backwards for the OPENING quote: the marker sits inside the string, so searching forward finds its
  // closing quote and slices the wrong span — which is how the first version of this read `,\n className`
  // as the primitive's classes and asserted against nothing.
  const open = source.lastIndexOf('"', at);
  const close = source.indexOf('"', at);
  return source.slice(open + 1, close);
}

interface CallSite {
  file: string;
  line: number;
  requested: string;
  className: string;
}

/** Every `<DialogContent className="…">` in the app, with the width it asks for. */
function dialogCallSites(): CallSite[] {
  const found: CallSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (!line.includes("<DialogContent")) return;
          // THROUGH THE CLOSING `>`, not a fixed window. The first version read three lines, which missed
          // `weekly-report-project-dialog.tsx` — two comment lines sit between the tag and its className,
          // putting the width on the fourth. That call site was absent from the sweep entirely, so it
          // could have regressed to a defeated width with all four tests still green: the coarse
          // `sites.length > 10` check happily passes while the one caller you care about is invisible.
          // A guard that silently covers less than it claims is the failure mode this file exists for.
          let tag = "";
          for (let i = index; i < Math.min(lines.length, index + 30); i += 1) {
            tag += " " + lines[i];
            if (lines[i]!.includes(">")) break;
          }
          const match = /className=\{?["`]([^"`]*)["`]/.exec(tag);
          if (!match) return;
          const className = match[1];
          const width = /(?:^|\s)((?:sm:|md:|lg:|xl:)?!?max-w-[^\s]+)/.exec(className);
          if (!width) return;
          found.push({
            file: path.relative(CLIENT_SRC, full),
            line: index + 1,
            requested: width[1],
            className,
          });
        });
      }
    }
  };
  walk(CLIENT_SRC);
  return found;
}


/**
 * Tailwind widths at or below the `sm` breakpoint (640px), which this guard deliberately does not police.
 *
 * `sm:` FIXES A WIDTH ONLY IF THAT WIDTH IS WIDER THAN THE BREAKPOINT. `max-w-md` is 448px — narrower than
 * the 640px the prefix starts at — so `sm:max-w-md` leaves the sub-640 range capped by the primitive's
 * inset instead, and a 600px window renders 568px rather than the 448px the author asked for. The fix for
 * a wide dialog is a regression for a narrow one.
 *
 * Those call sites keep their unprefixed width and stay clamped at 384px above `sm`. That is a real defect
 * and it is NOT fixed here: correcting it needs the primitive to stop pinning a default at all, which
 * resizes all 47 dialogs and wants a visual pass. Naming them here keeps the exemption honest rather than
 * letting the guard quietly report success over a category it cannot handle.
 */
const NARROWER_THAN_BREAKPOINT = /^(?:sm:|md:|lg:|xl:)?!?max-w-(?:0|px|xs|sm|md|\d|\d\.5|\d{1,2})$/;

describe("a dialog gets the width it asks for", () => {
  it("found call sites to check — an empty sweep would pass every assertion below vacuously", () => {
    // The failure mode of a source-scanning test: a moved directory or a changed element name makes the
    // list empty, and a loop over nothing is silently green.
    const sites = dialogCallSites();
    expect(sites.length).toBeGreaterThan(10);
  });

  it("still finds the primitive's own width pin, so the merge under test is the real one", () => {
    const base = baseClassesOf("components/ui/dialog.tsx", "fixed top-1/2 left-1/2");
    expect(base).toContain("max-w-");
  });

  it("leaves no dialog silently clamped by the primitive", () => {
    const base = baseClassesOf("components/ui/dialog.tsx", "fixed top-1/2 left-1/2");
    const clamp = base.split(/\s+/).find((c) => /^sm:max-w-/.test(c));
    expect(clamp, "the primitive no longer pins a sm: width — update this test").toBeDefined();

    const defeated = dialogCallSites().filter((site) => {
      const merged = twMerge(base, site.className).split(/\s+/);
      const clampSurvived = merged.includes(clamp!);
      const overrode = merged.some((c) => /^sm:!max-w-/.test(c));
      // A LATER BREAKPOINT IS NOT DEFEATED. `md:max-w-2xl` legitimately leaves `sm:max-w-sm` standing:
      // the dialog keeps the default width from 640–767px and takes the requested one at `md`, which is
      // what its author asked for. Flagging that would fail CI on correct code — and a guard that cries
      // wolf on valid usage is one people learn to route around with `!`, which is how this codebase
      // acquired nine escape hatches in the first place.
      const laterBreakpoint = merged.some((c) => /^(md|lg|xl|2xl):!?max-w-/.test(c));
      const tooNarrowToPrefix = NARROWER_THAN_BREAKPOINT.test(site.requested);
      return clampSurvived && !overrode && !laterBreakpoint && !tooNarrowToPrefix;
    });

    expect(
      defeated.map((d) => `${d.file}:${d.line} asked for ${d.requested}`),
      "these dialogs request a width the primitive silently overrides at sm and above",
    ).toEqual([]);
  });

  it("keeps the mobile inset, which an unprefixed caller width destroys", () => {
    // The other half of the same bug, and the half nobody notices: `max-w-2xl` replaces
    // `max-w-[calc(100%-2rem)]`, so the dialog goes edge-to-edge on a phone. A `sm:`-prefixed width does
    // not, because it is in a different group from the unprefixed inset — the same mechanism that causes
    // the desktop bug prevents this one.
    const base = baseClassesOf("components/ui/dialog.tsx", "fixed top-1/2 left-1/2");
    const inset = base.split(/\s+/).find((c) => /^max-w-\[calc/.test(c));
    expect(inset, "the primitive no longer sets a mobile inset — update this test").toBeDefined();

    const lostInset = dialogCallSites().filter(
      (site) =>
        !NARROWER_THAN_BREAKPOINT.test(site.requested) &&
        !twMerge(base, site.className).split(/\s+/).includes(inset!),
    );

    expect(
      lostInset.map((d) => `${d.file}:${d.line} (${d.requested})`),
      "these dialogs lose the phone inset because their width is not breakpoint-prefixed",
    ).toEqual([]);
  });
});
