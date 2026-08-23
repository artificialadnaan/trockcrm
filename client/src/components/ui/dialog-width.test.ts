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
          // The className may sit on the next line or two; join a small window and take the first string.
          const window = lines.slice(index, index + 3).join(" ");
          const match = /className=\{?["`]([^"`]*)["`]/.exec(window);
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
      // The caller lost if the primitive's own breakpoint clamp is STILL present and the caller did not
      // out-rank it with `!`. That is the exact condition under which the browser renders 384px.
      const clampSurvived = merged.includes(clamp!);
      const overrode = merged.some((c) => /^sm:!max-w-/.test(c));
      return clampSurvived && !overrode;
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
      (site) => !twMerge(base, site.className).split(/\s+/).includes(inset!),
    );

    expect(
      lostInset.map((d) => `${d.file}:${d.line} (${d.requested})`),
      "these dialogs lose the phone inset because their width is not breakpoint-prefixed",
    ).toEqual([]);
  });
});
