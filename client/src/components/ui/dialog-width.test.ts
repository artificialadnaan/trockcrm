import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
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

/** Call sites whose className cannot be read statically — populated by `dialogCallSites()`. */
const unresolvable: { file: string; line: number }[] = [];

interface CallSite {
  file: string;
  line: number;
  requested: string;
  className: string;
}

/**
 * Every `<DialogContent className="…">` in the app, with the width it asks for.
 *
 * PARSED, NOT SCANNED. Two earlier versions of this read lines, and both under-reported:
 *
 *   * the first took a fixed three-line window, which missed `weekly-report-project-dialog.tsx` — two
 *     comment lines sit between the tag and its className, putting the width on the fourth;
 *   * the second read "until the first line containing `>`", which ends the opening tag on the arrow of a
 *     prop like `onEscapeKeyDown={(event) => handle(event)}` and never reaches the className below it.
 *
 * Both failures are silent and both point the same way: the call site vanishes from the sweep, so a dialog
 * whose width is defeated passes every assertion in this file while being invisible to it. A guard that
 * quietly covers less than it claims is the exact failure this file exists to prevent, so it now asks the
 * TypeScript parser where the element ends instead of guessing from punctuation.
 */
let cachedSites: CallSite[] | null = null;

/** Parsed once. Four assertions used to reparse every TSX file under client/src, ~5.5s of repeated work. */
function dialogCallSites(): CallSite[] {
  if (cachedSites) return cachedSites;
  const found: CallSite[] = [];
  unresolvable.length = 0;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".tsx")) {
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
        if (opening.tagName.getText() === "DialogContent") {
          const variants = classNameVariants(opening);
          if (variants === null) {
            // UNRESOLVABLE, not absent. Part of this className lives behind a reference, so a defeated
            // width in it would never be reported. Recorded and asserted empty below, so introducing one
            // is a loud failure rather than a quiet loss of coverage.
            const { line } = source.getLineAndCharacterOfPosition(opening.getStart());
            unresolvable.push({ file: path.relative(CLIENT_SRC, file), line: line + 1 });
          } else if (variants !== undefined) {
            // ONE ENTRY PER VARIANT. Mutually exclusive branches are separate renderings and each has to
            // stand on its own; collapsing them into one string lets the surviving branch answer for the
            // one that lost.
            const { line } = source.getLineAndCharacterOfPosition(opening.getStart());
            for (const className of variants) {
              // EVERY width in the variant, not the first match. `requested` used to be whichever the
              // regex reached first, so the verdict depended on class ORDER: in
              // `className="lg:max-w-3xl max-w-2xl"` the prefixed one matched first, the site counted as
              // prefixed, and the unprefixed `max-w-2xl` — the one actually defeated between 640px and
              // 1023px — was never examined. One entry per requested width, each judged on its own.
              const widths = [
                ...className.matchAll(/(?:^|\s)((?:sm:|md:|lg:|xl:|2xl:)?!?max-w-[^\s]+)/g),
              ].map((m) => m[1]!);
              const relative = path.relative(CLIENT_SRC, file);
              if (widths.length === 0) {
                found.push({ file: relative, line: line + 1, requested: "", className });
                continue;
              }
              for (const requested of widths) {
                found.push({ file: relative, line: line + 1, requested, className });
              }
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  };

  walk(CLIENT_SRC);
  cachedSites = found;
  return found;
}

/**
 * Every class string an element can actually render with — one per combination of conditional branches.
 *
 * VARIANTS, NOT ONE JOINED STRING. The first version concatenated every literal it found, so
 * `cn(isWide ? "max-w-2xl" : "max-w-sm")` produced `"max-w-2xl max-w-sm"` — a string the component can
 * never render. tailwind-merge then collapses that to the LAST width, and whichever branch lost is checked
 * against nothing. Mutually exclusive branches have to be evaluated as the alternatives they are.
 *
 * Returns `null` when any part of the expression is behind a reference this sweep cannot follow. Partial is
 * not resolved: `cn(dialogClasses, "overflow-y-auto")` yields a literal, and an earlier version took that
 * as success and silently dropped whatever `dialogClasses` held.
 */
const CLASS_COMBINERS = new Set(["cn", "clsx", "classNames", "twMerge", "twJoin"]);

function classNameVariants(opening: ts.JsxOpeningLikeElement): string[] | null | undefined {
  // A SPREAD CAN CARRY `className`. `<DialogContent {...contentProps}>` was read as having none, so a
  // defeated width inside `contentProps` was invisible. It cannot be resolved here, so it is reported.
  if (opening.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p))) return null;

  for (const property of opening.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== "className") continue;
    const init = property.initializer;
    if (!init) return undefined;
    if (ts.isStringLiteral(init)) return [init.text];
    if (!ts.isJsxExpression(init) || !init.expression) return undefined;

    let opaque = false;
    /** Each node contributes a set of alternatives; the result is their cartesian product. */
    const alternatives = (node: ts.Node): string[] => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];

      if (ts.isConditionalExpression(node)) {
        // The branch point. Both arms are real renderings; neither may hide the other.
        return [...alternatives(node.whenTrue), ...alternatives(node.whenFalse)];
      }

      if (ts.isTemplateExpression(node)) {
        // INTERPOLATIONS ARE VISITED. An earlier version pushed the head and the span literals and
        // returned, never looking at `span.expression` — so `` `${dialogClasses} p-0` `` resolved to
        // " p-0" and read as fully resolved.
        let combos = [node.head.text];
        for (const span of node.templateSpans) {
          const inner = alternatives(span.expression);
          const next: string[] = [];
          for (const prefix of combos) {
            for (const piece of inner.length ? inner : [""]) {
              next.push(`${prefix} ${piece} ${span.literal.text}`);
            }
          }
          combos = next;
        }
        return combos;
      }

      if (ts.isBinaryExpression(node)) {
        // `open && "…"` — the falsy arm contributes nothing, which is itself a valid rendering.
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          return ["", ...alternatives(node.right)];
        }
        return [...alternatives(node.left), ...alternatives(node.right)];
      }

      if (ts.isObjectLiteralExpression(node)) {
        // The clsx object form: `cn({ "w-full": expanded })`. Each key is a class that may or may not be
        // present, so each contributes an alternative — with it and without it.
        let combos = [""];
        for (const prop of node.properties) {
          if (!ts.isPropertyAssignment(prop)) {
            opaque = true;
            continue;
          }
          const key = ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name) ? prop.name.text : null;
          if (key === null) {
            opaque = true;
            continue;
          }
          combos = combos.flatMap((prefix) => [prefix, `${prefix} ${key}`]);
        }
        return combos;
      }

      if (ts.isCallExpression(node)) {
        // ONLY a known combiner. `getDialogClasses()` is not one — its return value is classes this sweep
        // cannot see, and treating every call as `cn(...)` meant such a caller resolved to "" and read as
        // asking for no width.
        if (!ts.isIdentifier(node.expression) || !CLASS_COMBINERS.has(node.expression.text)) {
          opaque = true;
          return [];
        }
        // `cn(a, b, c)` — every argument contributes, so the product across them.
        let combos = [""];
        for (const argument of node.arguments) {
          const inner = alternatives(argument);
          const next: string[] = [];
          for (const prefix of combos) {
            for (const piece of inner.length ? inner : [""]) next.push(`${prefix} ${piece}`);
          }
          combos = next;
        }
        return combos;
      }

      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        opaque = true;
        return [];
      }

      if (ts.isParenthesizedExpression(node)) return alternatives(node.expression);
      // Contributes nothing and cannot: a literal `undefined`/`null`/boolean in a `cn()` argument list.
      if (
        node.kind === ts.SyntaxKind.NullKeyword ||
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword ||
        (ts.isIdentifier(node) && node.text === "undefined")
      ) {
        return [""];
      }
      if (ts.isArrayLiteralExpression(node)) {
        let combos = [""];
        for (const element of node.elements) {
          const inner = alternatives(element);
          const next: string[] = [];
          for (const prefix of combos) {
            for (const piece of inner.length ? inner : [""]) next.push(`${prefix} ${piece}`);
          }
          combos = next;
        }
        return combos;
      }
      // ANYTHING ELSE IS LOUD. Returning [] here is what let three separate shapes — clsx objects,
      // non-combiner calls, spreads — resolve to "" and read as "this dialog asks for no width". A guard
      // cannot enumerate every expression somebody might write, so the default is to admit it does not
      // know rather than to guess that the answer is "nothing".
      opaque = true;
      return [];
    };

    const variants = alternatives(init.expression);
    if (opaque) return null;
    return variants.map((v) => v.replace(/\s+/g, " ").trim());
  }
  return undefined;
}

/**
 * Tailwind widths at or below the `sm` breakpoint (640px), which this guard deliberately does not police.
 *
 * `sm:` FIXES A WIDTH ONLY IF THAT WIDTH IS WIDER THAN THE BREAKPOINT. `max-w-md` is 448px — narrower than
 * the 640px the prefix starts at — so `sm:max-w-md` leaves the sub-640 range capped by the primitive's
 * inset instead, and a 600px window renders 568px rather than the 448px the author asked for. The fix for
 * a wide dialog is a regression for a narrow one.
 *
 * `lg` (512px) and `xl` (576px) belong here too and were missing: both are below 640, so both hit the same
 * trap, and leaving them out meant the guard demanded a prefix that would have made them worse.
 *
 * Those call sites keep their unprefixed width and stay clamped at 384px above `sm`. That is a real defect
 * and it is NOT fixed here: correcting it needs the primitive to stop pinning a default at all, which
 * resizes all 47 dialogs and wants a visual pass. Naming them here keeps the exemption honest rather than
 * letting the guard quietly report success over a category it cannot handle.
 */
const NARROWER_THAN_BREAKPOINT =
  /^(?:sm:|md:|lg:|xl:|2xl:)?!?max-w-(?:0|px|xs|sm|md|lg|xl|\d|\d\.5|\d{1,2})$/;

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
      // A call site with a className but NO width asks for nothing and cannot be defeated. It is collected
      // anyway, because the edge-to-edge assertion below needs to see `w-full` regardless of `max-w-*`.
      if (!site.requested) return false;
      const merged = twMerge(base, site.className).split(/\s+/);
      const clampSurvived = merged.includes(clamp!);
      const overrode = merged.some((c) => /^sm:!max-w-/.test(c));
      // A LATER BREAKPOINT IS NOT DEFEATED. `md:max-w-2xl` legitimately leaves `sm:max-w-sm` standing:
      // the dialog keeps the default width from 640–767px and takes the requested one at `md`, which is
      // what its author asked for. Flagging that would fail CI on correct code — and a guard that cries
      // wolf on valid usage is one people learn to route around with `!`, which is how this codebase
      // acquired nine escape hatches in the first place.
      // SCOPED TO THE REQUESTED WIDTH. `md:max-w-2xl` alone is legitimate: the author accepts the default
      // below `md` and their width above it. But `max-w-2xl lg:max-w-3xl` is NOT rescued by its `lg:` —
      // the UNPREFIXED width is meant to apply from 0 up, and between 640px and 1023px the primitive's
      // `sm:max-w-sm` overrides it anyway. The first version exempted the whole call site whenever any
      // later-breakpoint width appeared, so that dialog rendered at 384px through the entire band with
      // this guard reporting it fine.
      const requestedIsPrefixed = /^(sm|md|lg|xl|2xl):/.test(site.requested);
      const laterBreakpoint =
        requestedIsPrefixed && merged.some((c) => /^(md|lg|xl|2xl):!?max-w-/.test(c));
      const tooNarrowToPrefix = NARROWER_THAN_BREAKPOINT.test(site.requested);
      return clampSurvived && !overrode && !laterBreakpoint && !tooNarrowToPrefix;
    });

    expect(
      defeated.map((d) => `${d.file}:${d.line} asked for ${d.requested}`),
      "these dialogs request a width the primitive silently overrides at sm and above",
    ).toEqual([]);
  });

  it("can read every call site's className, rather than silently skipping the ones it cannot", () => {
    // A dialog whose classes come from a variable — `className={dialogClasses}` — has no literal for this
    // sweep to read. Returning "" for it would have looked exactly like "this dialog asks for no width",
    // and it would have been excluded from both checks above without a word. There are none today; this
    // fails the moment one appears, which is the point at which someone has to decide how to cover it.
    dialogCallSites();
    expect(
      unresolvable.map((u) => `${u.file}:${u.line}`),
      "these dialogs take their className from a reference this sweep cannot resolve",
    ).toEqual([]);
  });

  it("leaves no dialog pinned edge to edge by its own w-full", () => {
    // THE SECOND HALF OF THE SAME BUG, and the half the first fix only half-solved.
    //
    // The inset used to be `w-full max-w-[calc(100%-2rem)]`. `max-w-*` is one property, so a caller's
    // `sm:max-w-5xl` did not lose to it — above 640px the responsive rule simply wins, `w-full` keeps the
    // box viewport-wide, and the dialog goes edge to edge. On an 800px tablet that is an 800px dialog with
    // no margin at all. Prefixing the caller fixed the phone and left this band broken.
    //
    // The primitive's inset is now `w-[calc(100%-2rem)]`, a WIDTH: no `max-width` in any group at any
    // breakpoint can override a different property, so the inset survives everything. What CAN still
    // remove it is a caller setting its own width — and `w-full` is exactly the old bug written by hand.
    //
    // A caller with a deliberate width of its own is fine and is NOT flagged:
    // `w-[min(96vw,1040px)]` carries its own 96vw inset. The defect is specifically `w-full`.
    const base = baseClassesOf("components/ui/dialog.tsx", "fixed top-1/2 left-1/2");
    // ANY breakpoint variant, not the bare utility. `sm:w-full` survives tailwind-merge alongside the
    // primitive's unprefixed inset and makes the dialog edge to edge from 640px up — the same defect, one
    // prefix away, and an exact-match check reported it clean.
    const edgeToEdge = dialogCallSites().filter((site) =>
      twMerge(base, site.className)
        .split(/\s+/)
        .some((c) => /^(?:[^:\s]+:)*!?w-full$/.test(c)),
    );

    expect(
      edgeToEdge.map((d) => `${d.file}:${d.line} (${d.requested})`),
      "these dialogs sit edge to edge — w-full replaces the primitive's inset",
    ).toEqual([]);
  });

  it("no longer carries a max-width inset a caller could beat above the breakpoint", () => {
    // The regression guard for the fix itself. Reintroducing `max-w-[calc(100%-2rem)]` would restore the
    // exact defeat described above, and every other assertion in this file would stay green.
    const base = baseClassesOf("components/ui/dialog.tsx", "fixed top-1/2 left-1/2");
    expect(base).not.toMatch(/max-w-\[calc/);
  });
});
