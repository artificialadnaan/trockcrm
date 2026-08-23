import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { twMerge } from "tailwind-merge";

// A SORT CONTROL YOU HAVE TO AIM AT.
//
// Measured on the deployed app, every sort header in the CRM is a 16px-tall button — the height of its own
// text and nothing more. WCAG 2.2 SC 2.5.8 sets the minimum target at 24×24 CSS px, and none of the
// exceptions apply: these are standalone controls in a header cell, not links inside a sentence, and there
// is no larger equivalent elsewhere on the page. On a touch screen a 16px target is a guess.
//
// It is ONE component — `SortHeaderButton` — behind eleven tables: files, companies, contacts, weekly
// reports, team commissions, at-risk, customer concentration, the director scorecard, platform usage. So
// the defect is one line and so is the fix, which is exactly why it is worth a guard: the next person to
// pass a `className` through can silently undo it for every one of those tables at once.
//
// WHAT THIS ASSERTS, AND WHAT IT CANNOT. jsdom has no layout — `getBoundingClientRect` is all zeroes — so
// no unit test in this suite can measure a rendered pixel. What it CAN do is run the real merge over the
// real caller strings and check the height floor survives, which is the part that silently breaks. The
// pixel measurement belongs to Playwright against the deployed page, and that is where this was found.
//
// The sweep matters more than the component check. `cn` is tailwind-merge: a caller passing `min-h-0` or
// `h-4` in the same group REPLACES the floor rather than losing to it, with no error and no visual cue
// until someone measures. Nine dialogs in this codebase reached production 37% narrower than they asked
// for by that exact mechanism, so the callers are checked, not just the default.

const SORTABLE_DIR = __dirname;
const CLIENT_SRC = path.resolve(__dirname, "../../..");

const WCAG_MINIMUM_PX = 24;

/** Sentinel for a `min-h-*` token this evaluator cannot turn into a number. Never silently ignored. */
const UNRESOLVABLE = Symbol("unresolvable min-height");

/**
 * The floor a single `min-h-*` token sets, in px.
 *
 * ARBITRARY AND PREFIXED VALUES BOTH COUNT. The first version held a hard-coded map from `min-h-0` to
 * `min-h-11`, which meant `min-h-[1px]` and `md:min-h-0` were both invisible: the lookup missed them, the
 * base 24 survived as the answer, and the caller was reported safe while its surviving utility set a
 * smaller floor — or none at all above a breakpoint. A guard that cannot see the override is not a guard.
 */
function tokenFloorPx(token: string): number | typeof UNRESOLVABLE | null {
  const match = /^(?:(sm|md|lg|xl|2xl):)?!?min-h-(.+)$/.exec(token);
  if (!match) return null;
  const value = match[2]!;
  if (value === "px") return 1;
  if (/^\d+$/.test(value)) return Number(value) * 4;
  if (/^\d+\.5$/.test(value)) return Number(value) * 4;
  const arbitrary = /^\[(.+)\]$/.exec(value);
  if (arbitrary) {
    const raw = arbitrary[1]!;
    const px = /^([\d.]+)px$/.exec(raw);
    if (px) return Number(px[1]);
    const rem = /^([\d.]+)rem$/.exec(raw);
    if (rem) return Number(rem[1]) * 16;
    return UNRESOLVABLE;
  }
  // `full`, `screen`, `fit`, `min`, `max`, `dvh` … all depend on a container this sweep cannot see.
  return UNRESOLVABLE;
}

/**
 * The WORST floor a merged class string leaves, in px — or null when it sets none.
 *
 * The minimum across every variant, not the last one seen. `min-h-6 md:min-h-0` keeps BOTH after
 * tailwind-merge (different groups), and the button is 0-floored from `md` upward — which is most desktop
 * viewports. Taking the last token, or only the unprefixed one, reports that as safe.
 */
function minHeightOf(classes: string): number | typeof UNRESOLVABLE | null {
  let worst: number | null = null;
  for (const token of classes.split(/\s+/)) {
    const floor = tokenFloorPx(token);
    if (floor === null) continue;
    if (floor === UNRESOLVABLE) return UNRESOLVABLE;
    worst = worst === null ? floor : Math.min(worst, floor);
  }
  return worst;
}

/**
 * The class string the component applies before any caller's, read from source so it cannot drift.
 *
 * VIA THE PARSER, not a text search. The first version anchored on the literal
 * `"inline-flex items-center gap-1"` — which is the string this change edits, so adding `min-h-6` broke
 * the guard's own anchor and all three real assertions failed with "the base class string moved". A guard
 * whose anchor is the thing it guards fails on exactly the commit it exists to check, which reads as a
 * broken test rather than a caught defect. This asks for the first literal argument of the `cn(...)` call
 * instead, which survives any edit to its contents.
 */
function baseClasses(): string {
  const file = path.join(SORTABLE_DIR, "sort-header-button.tsx");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  let base: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      base === null &&
      ts.isCallExpression(node) &&
      node.expression.getText() === "cn" &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      base = (node.arguments[0] as ts.StringLiteral).text;
    }
    node.forEachChild(visit);
  };
  visit(source);

  expect(base, "no cn(\"…\") base class string in the component — update this test").not.toBeNull();
  return base!;
}

interface Site {
  file: string;
  line: number;
  className: string;
  /** True when the classes live behind something this sweep could not follow. */
  opaque: boolean;
}

/**
 * Module-level `const NAME = "…"` string constants in a file, so `className={HEAD}` can be resolved.
 *
 * Three real call sites take this form — `HEAD`, `HEADER_CLASS`, `CC_HEADER_CLASS` — and the first version
 * of this sweep flattened them to "". An empty string reads as "this caller adds nothing", which is the
 * safest possible answer and happens to be wrong: those are exactly the strings that could carry a
 * height override, and the assertion passed over them without looking.
 */
function stringConstants(source: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      constants.set(node.name.text, node.initializer.text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return constants;
}

/** Flatten a className/buttonClassName initializer to the classes it can contribute. */
function classesOf(
  init: ts.JsxAttributeValue | undefined,
  constants: Map<string, string>,
): { className: string; opaque: boolean } {
  if (!init) return { className: "", opaque: false };
  if (ts.isStringLiteral(init)) return { className: init.text, opaque: false };
  if (!ts.isJsxExpression(init) || !init.expression) return { className: "", opaque: false };

  const parts: string[] = [];
  let opaque = false;
  const gather = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      parts.push(n.text);
      return;
    }
    if (ts.isIdentifier(n)) {
      const resolved = constants.get(n.text);
      if (resolved !== undefined) parts.push(resolved);
      else opaque = true;
      return;
    }
    n.forEachChild(gather);
  };
  gather(init.expression);
  return { className: parts.join(" "), opaque };
}

/**
 * Every place a class string reaches `SortHeaderButton`.
 *
 * TWO SHAPES, because there are two. Direct `<SortHeaderButton className=…>`, and `<SortableTableHead
 * buttonClassName=…>`, which forwards its prop straight through. Sweeping only the first leaves every
 * table that goes through the wrapper unchecked, and the wrapper is the shape most pages use.
 *
 * The forwarding site inside `sortable-table-head.tsx` itself is skipped: its `className={buttonClassName}`
 * is a prop by definition and can never be resolved there. It is covered by sweeping its CALLERS, which is
 * where the actual strings are written.
 */
function callSites(): Site[] {
  const found: Site[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
        collect(full);
      }
    }
  };

  const FORWARDER = path.join("components", "shared", "sortable-table-head.tsx");

  const collect = (file: string): void => {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const constants = stringConstants(source);
    const relative = path.relative(CLIENT_SRC, file);
    const isForwarder = relative === FORWARDER;

    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText();
        const attrName =
          tag === "SortHeaderButton" ? "className" : tag === "SortableTableHead" ? "buttonClassName" : null;

        if (attrName && !(isForwarder && tag === "SortHeaderButton")) {
          for (const property of opening.attributes.properties) {
            if (!ts.isJsxAttribute(property) || property.name.getText() !== attrName) continue;
            const { className, opaque } = classesOf(property.initializer, constants);
            const { line } = source.getLineAndCharacterOfPosition(opening.getStart());
            found.push({ file: relative, line: line + 1, className, opaque });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  };

  walk(CLIENT_SRC);
  return found;
}

describe("a sort header is big enough to hit", () => {
  it("sets a height floor of at least the WCAG minimum by default", () => {
    const floor = minHeightOf(baseClasses());
    expect(floor, "the component sets no min-height at all — its target is its text height").not.toBeNull();
    expect(floor).not.toBe(UNRESOLVABLE);
    expect(floor).toBeGreaterThanOrEqual(WCAG_MINIMUM_PX);
  });

  it("found the call sites — an empty sweep would pass everything below vacuously", () => {
    // The standing failure mode of a source sweep, and one this codebase has shipped: a renamed component
    // empties the list and a loop over nothing is green.
    expect(callSites().length).toBeGreaterThan(5);
  });

  it("reads every caller's classes, rather than treating what it cannot follow as empty", () => {
    // THE GAP THAT MADE THE NEXT ASSERTION WEAKER THAN IT LOOKED. Three real call sites pass
    // `className={HEAD}` / `{HEADER_CLASS}` / `{CC_HEADER_CLASS}`, and the first version flattened those to
    // "" — which reads as "adds nothing", the safest possible answer and the wrong one. Constants are now
    // resolved; anything still opaque is named here rather than quietly skipped.
    const opaque = callSites().filter((site) => site.opaque);
    expect(
      opaque.map((o) => `${o.file}:${o.line}`),
      "these callers' classes come from something this sweep cannot resolve",
    ).toEqual([]);
  });

  it("keeps that floor through every caller's className", () => {
    // `cn` is tailwind-merge, so a caller's `min-h-*` REPLACES the component's rather than losing to it —
    // silently, with no error and no visual cue. One caller can undo the fix for its own table while ten
    // others stay correct, which is the hardest kind of regression to notice.
    const base = baseClasses();
    const defeated = callSites().filter((site) => {
      const floor = minHeightOf(twMerge(base, site.className));
      return floor === null || floor === UNRESOLVABLE || floor < WCAG_MINIMUM_PX;
    });

    expect(
      defeated.map((d) => `${d.file}:${d.line} → ${twMerge(base, d.className)}`),
      "these callers drop the sort button below the 24px minimum target size",
    ).toEqual([]);
  });

  it.each([
    ["min-h-0", "the blunt override"],
    ["md:min-h-0", "a breakpoint override — survives the merge in its own group"],
    ["min-h-[1px]", "an arbitrary value the old hard-coded map could not see"],
    ["min-h-5", "one step under the minimum"],
  ])("detects %s (%s), rather than always passing", (override) => {
    // The mirror, and the reason it is a table. Every one of these was a way for the sweep above to return
    // 24 for a button that is smaller than 24 — the prefixed and arbitrary forms because the first version
    // looked them up in a hard-coded map and found nothing, leaving the base value standing as the answer.
    const floor = minHeightOf(twMerge(baseClasses(), override));
    expect(floor).not.toBe(UNRESOLVABLE);
    expect(floor as number).toBeLessThan(WCAG_MINIMUM_PX);
  });

  it("does not mistake a LARGER override for a defeat", () => {
    // The other direction. A caller asking for a taller target is correct, and a guard that fails on it
    // teaches people to route around the guard.
    expect(minHeightOf(twMerge(baseClasses(), "min-h-11"))).toBe(44);
  });
});
