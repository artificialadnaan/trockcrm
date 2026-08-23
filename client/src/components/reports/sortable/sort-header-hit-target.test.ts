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

/** The Tailwind min-height scale, in px, for the utilities this component might reasonably carry. */
const MIN_HEIGHT_PX: Record<string, number> = {
  "min-h-0": 0,
  "min-h-px": 1,
  "min-h-1": 4,
  "min-h-2": 8,
  "min-h-3": 12,
  "min-h-4": 16,
  "min-h-5": 20,
  "min-h-6": 24,
  "min-h-7": 28,
  "min-h-8": 32,
  "min-h-9": 36,
  "min-h-10": 40,
  "min-h-11": 44,
};

const WCAG_MINIMUM_PX = 24;

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

/** The resolved min-height of a merged class string, in px, or null when it sets no floor at all. */
function minHeightOf(classes: string): number | null {
  let found: number | null = null;
  for (const token of classes.split(/\s+/)) {
    const px = MIN_HEIGHT_PX[token.replace(/^!/, "")];
    if (px !== undefined) found = px;
  }
  return found;
}

/** Every `<SortHeaderButton className="…">` in the client, via the parser rather than a line scan. */
function callSites(): { file: string; line: number; className: string }[] {
  const found: { file: string; line: number; className: string }[] = [];

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

  const collect = (file: string): void => {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (opening.tagName.getText() === "SortHeaderButton") {
          for (const property of opening.attributes.properties) {
            if (!ts.isJsxAttribute(property) || property.name.getText() !== "className") continue;
            const init = property.initializer;
            const parts: string[] = [];
            if (init && ts.isStringLiteral(init)) parts.push(init.text);
            else if (init && ts.isJsxExpression(init) && init.expression) {
              const gather = (n: ts.Node): void => {
                if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
                n.forEachChild(gather);
              };
              gather(init.expression);
            }
            const { line } = source.getLineAndCharacterOfPosition(opening.getStart());
            found.push({
              file: path.relative(CLIENT_SRC, file),
              line: line + 1,
              className: parts.join(" "),
            });
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
    expect(floor).toBeGreaterThanOrEqual(WCAG_MINIMUM_PX);
  });

  it("found the call sites — an empty sweep would pass the next assertion vacuously", () => {
    // The standing failure mode of a source sweep, and one this codebase has shipped: a renamed component
    // empties the list and a loop over nothing is green.
    expect(callSites().length).toBeGreaterThan(5);
  });

  it("keeps that floor through every caller's className", () => {
    // THE ASSERTION THAT EARNS THIS FILE. `cn` is tailwind-merge, so a caller's `min-h-*` REPLACES the
    // component's rather than losing to it — silently, with no error and no visual cue. One caller can
    // undo the fix for its own table while ten others stay correct, which is the hardest kind of
    // regression to notice.
    const base = baseClasses();
    const defeated = callSites().filter((site) => {
      const floor = minHeightOf(twMerge(base, site.className));
      return floor === null || floor < WCAG_MINIMUM_PX;
    });

    expect(
      defeated.map((d) => `${d.file}:${d.line} → ${twMerge(base, d.className)}`),
      "these callers drop the sort button below the 24px minimum target size",
    ).toEqual([]);
  });

  it("actually detects a caller that defeats the floor, rather than always passing", () => {
    // The mirror. Without this, `minHeightOf` returning a constant — or the merge never being reached —
    // would make the sweep above green forever while checking nothing.
    const base = baseClasses();
    expect(minHeightOf(twMerge(base, "min-h-0"))).toBeLessThan(WCAG_MINIMUM_PX);
  });
});
