import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * Tree-wide guard for the Fabric image use-after-free crash (PR #956).
 *
 * `ImageResponseObserverCoordinator::nativeImageResponseProgress` snapshots `observers_` under its mutex,
 * unlocks, and *then* dereferences those RAW observer pointers. If a core RN <Image> unmounts in that
 * window the observer is already destroyed → EXC_BAD_ACCESS at 0x10. So no source file may reach a core
 * react-native image component, by any route.
 *
 * There is NO allowlist, deliberately. The obvious exemption — "it's a statically bundled require() asset,
 * so it loads synchronously" — is FALSE on Fabric: `RCTImageManager::requestImage` dispatch_asyncs *every*
 * request onto its background serial queue, and `RCTBundleAssetImageLoader` still fires
 * `progressHandler(1, 1)` from there, reaching the same coordinator. BrandLogo was exempted on exactly
 * that bad premise and has since been migrated. If you think you have a safe exception, read
 * RCTImageManager.mm first.
 *
 * WHY THIS PARSES INSTEAD OF GREPPING. This started as regexes over raw text and leaked five separate
 * ways, each found by review rather than by the guard: it missed `Animated.Image`; it missed
 * `const { Image } = require(...)`; it missed an ALIASED `Animated`; a lazy dot-all capture backtracked
 * across an earlier import and swallowed a real `import { Image } from "react-native"`; and — the design
 * flaw behind most of them — an unparseable specifier was silently DROPPED, so a single comment sitting
 * inside an import list next to `Image` disarmed it entirely. Text matching also produced the mirror
 * failure, flagging an `Image` that was only mentioned in a comment. Both classes vanish against a real
 * syntax tree: comments are trivia, aliases and binding forms are structure, formatting is irrelevant.
 *
 * `Animated.Image` is checked too, and not hypothetically: ZoomablePhoto renders the full-screen photo,
 * already imports `Animated`, and *was* an `Animated.Image` until PR #888 moved the transform onto an
 * `Animated.View` wrapper.
 *
 * KNOWN LIMIT — this is still a single-file syntactic check, not a type-checked whole-program one. It
 * resolves re-binding chains within a file to a fixed point (`const A = B; const B = RN; <A.Image />`) but
 * cannot follow a core component that leaves a file as an ordinary local export and is imported elsewhere
 * under a new name. It does flag every re-export barrel form (`export { Image } from "react-native"`,
 * `export *`, `export * as RN`), which is the practical version of that. Treat green as "no known route",
 * not a proof.
 *
 * An adversarial audit generated 43 candidate evasions and executed each against this implementation, and
 * a second review round found nine more. Everything confirmed is covered here and pinned by a self-test,
 * with three deliberate exceptions, all verified by execution rather than assumed:
 *
 *  1. `const RN = require("react-native")` with NO terminating semicolon followed by JSX. That source does
 *     not compile — TSX reads `require(…)` and the next line's `<` as a relational expression — so there is
 *     nothing to catch.
 *  2. Dynamic import resolved through a promise callback: `import("react-native").then(RN => RN.Image)`,
 *     or `.then(({ Image }) => Image)`. Following a module object into a callback parameter needs dataflow
 *     this check does not do. The awaited forms (`await import(…)`, `const { Image } = await import(…)`)
 *     ARE covered, and are what anyone would actually write.
 *  3. Shadowing beyond function parameters. A parameter named after a tracked binding is handled (see
 *     `shadowedByParameter`), because that was a live false positive. A block-scoped `const RN = notRN`
 *     inside a function is not modelled — binding tracking is per-file, not per-scope. Erring here yields a
 *     false POSITIVE (a failing build on safe code), not a missed crash.
 *
 * Closing 2 or 3 properly means a type-checked `ts.Program` with real symbol resolution, which is a large
 * step up in cost for routes nothing in this codebase uses. Revisit if that stops being true.
 *
 * WHERE THE LINE IS, AND WHY IT IS HERE. Review kept producing further evasions, and will continue to: the
 * ways to name a module member in TS/JS are effectively unbounded for a syntactic checker, so "no more
 * findings" is not a reachable state. The threat this guards against is not an adversary — it is a
 * developer re-introducing `import { Image } from "react-native"` during ordinary work, or a migration
 * sweep missing a file. Everything on that path is covered and pinned below.
 *
 * These are known and deliberately NOT covered, because writing them is already a conscious act that no
 * amount of pattern-matching would stop, and each additional branch has empirically been a place for a new
 * bug (three separate rounds here fixed a defect and introduced the next one):
 *   - destructuring ASSIGNMENT rather than declaration: `let Image; ({ Image } = RN);`
 *   - a conditional/logical initializer: `const M = cond ? RN : other; M.Image`
 *   - a barrel that re-exports `Animated` for a consumer to reach `Animated.Image` through
 *   - a value import consumed only in type position, which TypeScript erases (this one is a false
 *     POSITIVE, and arguably correct to flag anyway — importing core Image at all is the footgun)
 * Prefer adding a case here, with its reasoning, over quietly growing the matcher.
 */

const MOBILE_ROOT = path.resolve(__dirname, "../..");
const SCANNED_DIRS = ["app", "src"];
// Metro bundles JS as readily as TS; a core <Image> in a .js file crashes exactly the same.
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Image components from "react-native" that route through RCTImageManager. */
const CORE_IMAGE_NAMES = new Set(["Image", "ImageBackground"]);

function sourceFiles(dir: string): string[] {
  const abs = path.join(MOBILE_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (SOURCE_EXT.has(path.extname(entry.name))) out.push(path.relative(MOBILE_ROOT, full));
    }
  };
  walk(abs);
  return out;
}

/** `react-native` itself, or a deep path into it — `react-native/Libraries/Image/Image` is the same component. */
function isReactNativeModule(specifier: string): boolean {
  return specifier === "react-native" || specifier.startsWith("react-native/");
}

/**
 * A react-native subpath that IS the image module rather than the package. `react-native/index.js` merely
 * re-exports these (`get Image() { return require('./Libraries/Image/Image').default; }`), so importing the
 * subpath directly yields the identical component — but its DEFAULT export is the component, not a module
 * namespace, so it has to be recognised separately.
 */
function coreImageModulePath(specifier: string): string | null {
  if (!specifier.startsWith("react-native/")) return null;
  // Strip a platform suffix and/or an extension, in either combination: `Image`, `Image.ios`,
  // `Image.ios.js`, `Image.js`. Metro resolves all of them to the same module.
  const base = (specifier.split("/").pop() ?? "")
    .replace(/\.[jt]sx?$/, "")
    .replace(/\.(ios|android|native|web)$/, "");
  return CORE_IMAGE_NAMES.has(base) ? base : null;
}

/** The module string of a `require("…")` or dynamic `import("…")` call, if that is what this node is. */
function loaderCallModule(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  if (!isRequire && !isDynamicImport) return null;
  const [arg] = node.arguments;
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/**
 * Metro resolves JSX inside plain `.js` as happily as `.tsx`. Handing such a file ScriptKind.TS makes the
 * parser reject the JSX and never build the member-access nodes, so the scan would silently see nothing —
 * the JS coverage would be decorative. `.ts` must stay ScriptKind.TS so angle-bracket type assertions parse.
 */
function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".ts")) return ts.ScriptKind.TS;
  if (/\.(jsx|js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TSX;
}

/**
 * Strip the wrappers that are transparent at runtime, so `(await import("react-native")).Image`,
 * `<typeof import("react-native")>require("react-native")` and `require("react-native") satisfies X` all
 * read as the underlying expression.
 */
function unwrap(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (current.kind === ts.SyntaxKind.TypeAssertionExpression || current.kind === ts.SyntaxKind.SatisfiesExpression) {
      current = (current as ts.TypeAssertion | ts.SatisfiesExpression).expression;
      continue;
    }
    return current;
  }
}

/**
 * Is this identifier a function parameter rather than the module binding of the same name? Without this,
 * `import * as RN from "react-native"; function read(RN: Data) { return RN.Image; }` fails the guard on
 * code that never touches react-native. Only parameters are modelled — see the KNOWN LIMIT above.
 */
function shadowedByParameter(id: ts.Identifier): boolean {
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)
      && node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) {
      return true;
    }
  }
  return false;
}

/** The accessed member name — `RN.Image` and `RN["Image"]` are the same property read. */
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const arg = node.argumentExpression;
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** Every way this file can reach a core RN image component, as human-readable reasons (empty = clean). */
export function coreImageReaches(contents: string, fileName = "probe.tsx"): string[] {
  const source = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));

  const reasons = new Set<string>();
  const rnModule = new Set<string>(); // locals holding the whole react-native module
  const rnAnimated = new Set<string>(); // locals holding react-native's Animated
  const coreLocal = new Set<string>(); // locals holding a core Image/ImageBackground component

  /**
   * The core component a `require()`/`import()` of an image SUBPATH yields, rather than a module object.
   * `.default` is included because that is react-native's own idiom — index.js is literally
   * `get Image() { return require('./Libraries/Image/Image').default; }`.
   */
  const loadedCoreImage = (node: ts.Expression): string | null => {
    let expr = unwrap(node);
    if ((ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) && memberName(expr) === "default") {
      expr = unwrap(expr.expression);
    }
    const mod = loaderCallModule(expr);
    return mod === null ? null : coreImageModulePath(mod);
  };

  /** Does this expression evaluate to the react-native module object? */
  const isRnModuleExpr = (node: ts.Expression): boolean => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) return rnModule.has(expr.text) && !shadowedByParameter(expr);
    const mod = loaderCallModule(expr);
    // An image subpath yields the COMPONENT, not the package — do not treat it as a namespace.
    return mod !== null && isReactNativeModule(mod) && coreImageModulePath(mod) === null;
  };

  /** Does this expression evaluate to react-native's Animated? */
  const isRnAnimatedExpr = (node: ts.Expression): boolean => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) return rnAnimated.has(expr.text) && !shadowedByParameter(expr);
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      return memberName(expr) === "Animated" && isRnModuleExpr(expr.expression);
    }
    return false;
  };

  /** Record one `imported → local` binding taken off the react-native module (or off Animated). */
  const bindName = (imported: string, local: string, origin: "module" | "animated", how: string) => {
    if (CORE_IMAGE_NAMES.has(imported)) {
      coreLocal.add(local);
      reasons.add(`${how} ${imported} from "react-native"`);
      return;
    }
    if (origin === "module" && imported === "Animated") rnAnimated.add(local);
  };

  /** The statically-known property a destructuring element reads: `{ Image }`, `{ Image: X }`, `{ ["Image"]: X }`. */
  const destructuredKey = (element: ts.BindingElement): string | null => {
    const name = element.propertyName;
    if (!name) return ts.isIdentifier(element.name) ? element.name.text : null;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
    return null;
  };

  const readBindingPattern = (pattern: ts.ObjectBindingPattern, origin: "module" | "animated", how: string) => {
    for (const element of pattern.elements) {
      const imported = destructuredKey(element);
      if (!imported) continue;
      // `const { Animated: { Image: X } } = require("react-native")` — recurse rather than stop at the nest.
      if (ts.isObjectBindingPattern(element.name)) {
        if (origin === "module" && imported === "Animated") {
          readBindingPattern(element.name, "animated", "destructures Animated.");
        }
        continue;
      }
      if (ts.isIdentifier(element.name)) bindName(imported, element.name.text, origin, how);
    }
  };

  // Collect bindings. Two passes so a local defined after its use (or chained through another local)
  // still resolves — cheap, and it removes any dependence on declaration order.
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && isReactNativeModule(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      // Importing the image module directly: its default/namespace binding IS the core component.
      const asComponent = coreImageModulePath(node.moduleSpecifier.text);
      if (asComponent && !clause?.isTypeOnly) {
        const local = clause?.name?.text ?? (named && ts.isNamespaceImport(named) ? named.name.text : null);
        if (local) {
          coreLocal.add(local);
          reasons.add(`binds ${asComponent} from "react-native"`);
        }
      }
      if (clause?.name && !asComponent) rnModule.add(clause.name.text); // import RN from "react-native"
      if (named && ts.isNamespaceImport(named) && !asComponent) rnModule.add(named.name.text);
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly || clause?.isTypeOnly) continue; // a type can't render
          bindName((element.propertyName ?? element.name).text, element.name.text, "module", "binds");
        }
      }
    }

    // A barrel re-publishes the identical component to every consumer. `export type` publishes no runtime
    // value at all, so a type barrel must not be flagged.
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier) && isReactNativeModule(node.moduleSpecifier.text)) {
      const spec = node.moduleSpecifier.text;
      const subpathComponent = coreImageModulePath(spec);
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        // `export *` / `export * as RN` hand a consumer everything the module has. That only exposes an
        // image component if the module IS the package root or the image module itself — starring an
        // unrelated subpath (…/StyleSheet/StyleSheet) exposes nothing, and flagging it would fail the
        // build on safe code.
        if (spec === "react-native" || subpathComponent) {
          reasons.add('re-exports all of "react-native" (including Image) from this module');
        }
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const imported = (element.propertyName ?? element.name).text;
          // From the image module itself, ANY value re-export republishes the component — including the
          // idiomatic `export { default as Image }`.
          if (subpathComponent) reasons.add(`re-exports ${subpathComponent} from "react-native"`);
          else if (CORE_IMAGE_NAMES.has(imported)) reasons.add(`re-exports ${imported} from "react-native"`);
        }
      }
    }

    // import RN = require("react-native")
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)
      && isReactNativeModule(node.moduleReference.expression.text)) {
      rnModule.add(node.name.text);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      const fromModule = isRnModuleExpr(init);
      const fromAnimated = isRnAnimatedExpr(init);

      // `const Image = require("react-native/Libraries/Image/Image")` binds the COMPONENT, not the package.
      const loadedComponent = loadedCoreImage(init);

      if (ts.isIdentifier(node.name)) {
        if (loadedComponent) {
          coreLocal.add(node.name.text);
          reasons.add(`binds ${loadedComponent} from "react-native"`);
        } else if (fromModule) rnModule.add(node.name.text);
        else if (fromAnimated) rnAnimated.add(node.name.text);
        else if (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
          const member = memberName(init);
          if (member && isRnModuleExpr(init.expression)) bindName(member, node.name.text, "module", "reads");
          else if (member && isRnAnimatedExpr(init.expression)) {
            if (CORE_IMAGE_NAMES.has(member)) {
              coreLocal.add(node.name.text);
              reasons.add(`reads Animated.${member} from "react-native"`);
            }
          }
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        if (fromModule) readBindingPattern(node.name, "module", "binds");
        else if (fromAnimated) readBindingPattern(node.name, "animated", "destructures Animated.");
      }
    }

    // `let RN; RN = require("react-native")` — an assignment, not a declaration.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      if (isRnModuleExpr(node.right)) rnModule.add(node.left.text);
      else if (isRnAnimatedExpr(node.right)) rnAnimated.add(node.left.text);
    }

    ts.forEachChild(node, collect);
  };
  // Iterate to a FIXED POINT, not a fixed number of passes. Each pass can only learn a binding whose
  // right-hand side was already known, so a chain (`const A = B; const B = C; const C = RN`) needs one pass
  // per link; two passes leave the head of a three-link chain unresolved. The sets only ever grow, so this
  // terminates — bounded anyway, since each pass must add at least one name to continue.
  for (let previous = -1; previous !== rnModule.size + rnAnimated.size + coreLocal.size + reasons.size; ) {
    previous = rnModule.size + rnAnimated.size + coreLocal.size + reasons.size;
    collect(source);
  }

  // Usages that reach the component through a binding rather than naming it at import time.
  const inspect = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = memberName(node);
      if (member && CORE_IMAGE_NAMES.has(member)) {
        if (isRnModuleExpr(node.expression)) reasons.add(`reads ${member} off the react-native module`);
        else if (isRnAnimatedExpr(node.expression)) reasons.add(`renders Animated.${member}`);
      }
    }

    // createAnimatedComponent(Image) — only when the ARGUMENT really is a core RN binding, so wrapping
    // expo-image's Image (a perfectly safe thing to do) is not flagged.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isFactory = (ts.isIdentifier(callee) && callee.text === "createAnimatedComponent")
        || ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
          && memberName(callee) === "createAnimatedComponent");
      const [arg] = node.arguments;
      if (isFactory && arg && ts.isIdentifier(arg) && coreLocal.has(arg.text)) {
        reasons.add(`wraps core ${arg.text} via createAnimatedComponent`);
      }
    }

    ts.forEachChild(node, inspect);
  };
  inspect(source);

  return [...reasons];
}

describe("no core react-native <Image> anywhere", () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);
  const read = (file: string) => fs.readFileSync(path.join(MOBILE_ROOT, file), "utf8");

  it("scans the whole mobile source tree", () => {
    // Guards the walker itself: a broken path would make the assertions below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/components/BrandLogo.tsx");
    expect(files).toContain("app/(app)/capture.tsx");
  });

  it("renders every image through expo-image", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      const reasons = coreImageReaches(read(file), file);
      if (reasons.length > 0) offenders[file] = reasons;
    }

    expect(offenders).toEqual({});
  });

  it("would catch a core <Image> reintroduced into any real file's react-native import", () => {
    // The assertion above passing proves nothing on its own — a parser that silently fails on our actual
    // file shapes reports zero offenders too, and the previous regex implementation did exactly that. So:
    // take every real file that imports from react-native, splice `Image` into that import, and require
    // the guard to fire. Synthetic snippets cannot cover this; the shape that breaks a parser is a real
    // file. Spliced at the HEAD of the list — appending would land after a trailing comma and produce
    // `,, Image`, i.e. a syntax error rather than the regression being simulated.
    // `[^{}]` not `[\s\S]`: with a dot-all body this very helper backtracks across an earlier
    // `import React, { Suspense } from "react"` and splices into THAT declaration, leaving the
    // react-native import untouched — the test would then report the guard as broken when it is fine.
    // (Same defect the guard itself shipped with. It is an easy one to write twice.)
    const rnImport = /(import\s+(?:\w+\s*,\s*)?\{)([^{}]*?)(\}\s*from\s*["']react-native["'])/;
    // Test files are excluded as SPLICE targets because they hold import-shaped STRINGS as data (this one
    // certainly does), so the splice would edit a string literal, which correctly reaches nothing. They
    // are still covered by the real assertion above — and that assertion passing over this very file,
    // whose test data is full of `import { Image } from "react-native"`, is the clearest demonstration
    // that the parser reads strings as strings. The previous text-matching implementation flagged them.
    const targets = files.filter((file) => !file.includes("__tests__") && rnImport.test(read(file)));

    expect(targets.length).toBeGreaterThan(20); // a real sample, not a handful

    const missed = targets.filter(
      (file) => !coreImageReaches(read(file).replace(rnImport, "$1 Image,$2$3"), file)
        .includes('binds Image from "react-native"'),
    );

    expect(missed).toEqual([]);
  });

  describe("the guard itself detects every route to the core component", () => {
    // Without these, a silently-broken parser would let the assertions above pass on a crashing tree.
    // Every case here was a real miss in the regex implementation this replaced.
    it.each([
      ['import { Image } from "react-native";', 'binds Image from "react-native"'],
      ['import { Image as RNImage } from "react-native";', 'binds Image from "react-native"'],
      ['import{Image}from"react-native";', 'binds Image from "react-native"'], // no whitespace
      ['import Default, { Image } from "react-native";', 'binds Image from "react-native"'],
      // Import ORDER must not matter, and neither may a comment inside the specifier list.
      [
        'import { Image as ExpoImage } from "expo-image";\nimport { Image } from "react-native";',
        'binds Image from "react-native"',
      ],
      ['import { View, /* legacy */ Image } from "react-native";', 'binds Image from "react-native"'],
      [
        'import {\n  View, // layout\n  Image,\n} from "react-native";',
        'binds Image from "react-native"',
      ],
      // Deep subpath — react-native/index.js just re-exports this exact module.
      ['import Image from "react-native/Libraries/Image/Image";', 'binds Image from "react-native"'],
      ['const { Image } = require("react-native");', 'binds Image from "react-native"'],
      ['const { Image: RNImage } = require("react-native");', 'binds Image from "react-native"'],
      ['const { foo } = bar;\nconst { Image } = require("react-native");', 'binds Image from "react-native"'],
      ['const RN = require("react-native"), Img = RN.Image;', 'reads Image from "react-native"'],
      ['const Img = require("react-native").Image;', 'reads Image off the react-native module'],
      ['import * as RN from "react-native";\n<RN.Image source={{ uri }} />', "reads Image off the react-native module"],
      ['import * as RN from "react-native";\nconst Img = RN["Image"];', 'reads Image from "react-native"'],
      ['import RN from "react-native";\n<RN.Image source={{ uri }} />', "reads Image off the react-native module"],
      ['import RN = require("react-native");\n<RN.Image source={{ uri }} />', "reads Image off the react-native module"],
      ['let RN;\nRN = require("react-native");\n<RN.Image source={{ uri }} />', "reads Image off the react-native module"],
      ['const Img = require("react-native").ImageBackground;', "reads ImageBackground off the react-native module"],
      ['const { Image } = await import("react-native");', 'binds Image from "react-native"'],
      // Re-binding chains, within a file.
      ['import * as RN from "react-native";\nconst Core = RN;\n<Core.Image source={{ uri }} />', "reads Image off the react-native module"],
      ['import * as RN from "react-native";\nconst { Image } = RN;', 'binds Image from "react-native"'],
      // Barrels re-publish the identical component.
      ['export { Image } from "react-native";', 're-exports Image from "react-native"'],
      ['export * from "react-native";', 're-exports all of "react-native" (including Image) from this module'],
      // Animated — matched on the local binding, not the literal spelling.
      ['import { Animated } from "react-native";\n<Animated.Image source={{ uri }} />', "renders Animated.Image"],
      [
        'import { Animated as RNAnimated } from "react-native";\n<RNAnimated.Image source={{ uri }} />',
        "renders Animated.Image",
      ],
      [
        'const { Animated: RNAnimated } = require("react-native");\n<RNAnimated.ImageBackground source={{ uri }} />',
        "renders Animated.ImageBackground",
      ],
      ['import { Animated } from "react-native";\nconst { Image } = Animated;', 'destructures Animated. Image from "react-native"'],
      ['import * as RN from "react-native";\n<RN.Animated.Image source={{ uri }} />', "renders Animated.Image"],
      ['const Img = require("react-native").Animated.Image;', "renders Animated.Image"],
      [
        'import { Animated, Image } from "react-native";\nAnimated.createAnimatedComponent( Image )',
        "wraps core Image via createAnimatedComponent",
      ],
      [
        'import { Animated as A, Image as RNImage } from "react-native";\nA.createAnimatedComponent(RNImage)',
        "wraps core RNImage via createAnimatedComponent",
      ],
      // Requiring the image subpath yields the COMPONENT, not the package — it must not be filed as a namespace.
      ['const Image = require("react-native/Libraries/Image/Image");', 'binds Image from "react-native"'],
      // Alias chains longer than two links: resolution runs to a fixed point, not a fixed pass count.
      [
        'import * as RN from "react-native";\nconst A = B;\nconst B = C;\nconst C = RN;\nconst I = A.Image;',
        "reads Image off the react-native module",
      ],
      // Destructuring that is computed, or nested under Animated.
      ['const { ["Image"]: CoreImage } = require("react-native");', 'binds Image from "react-native"'],
      [
        'const { Animated: { Image: CoreImage } } = require("react-native");',
        'destructures Animated. Image from "react-native"',
      ],
      // `export * as RN` hands a consumer the whole namespace, Image included.
      ['export * as RN from "react-native";', 're-exports all of "react-native" (including Image) from this module'],
      // `.default` is react-native's own idiom for the image subpath (see index.js).
      ['const Image = require("react-native/Libraries/Image/Image").default;', 'binds Image from "react-native"'],
      // Platform suffixes resolve to the same module, with or without an extension.
      ['import Image from "react-native/Libraries/Image/Image.ios";', 'binds Image from "react-native"'],
      ['import Image from "react-native/Libraries/Image/Image.ios.js";', 'binds Image from "react-native"'],
      // From the image module itself, any value re-export republishes the component.
      [
        'export { default as Image } from "react-native/Libraries/Image/Image";',
        're-exports Image from "react-native"',
      ],
      ['export * from "react-native/Libraries/Image/Image";', 're-exports all of "react-native" (including Image) from this module'],
    ])("flags %j", (source, expectedReason) => {
      expect(coreImageReaches(source)).toContain(expectedReason);
    });

    // Script kind is chosen per extension, so these need a filename to be meaningful.
    it.each([
      // Metro accepts JSX in plain .js. Parsing such a file as ScriptKind.TS silently yields no JSX nodes,
      // which would make the whole .js/.jsx coverage decorative.
      ['import * as RN from "react-native";\nexport const A = () => <RN.Image />;', "probe.js", "reads Image off the react-native module"],
      ['import { Image } from "react-native";\nexport const A = () => <Image />;', "probe.jsx", 'binds Image from "react-native"'],
      // Angle-bracket assertions only parse as .ts; `satisfies` is transparent at runtime in both.
      [
        'const RN = <typeof import("react-native")>require("react-native");\nconst I = RN.Image;',
        "probe.ts",
        "reads Image off the react-native module",
      ],
      [
        'const RN = require("react-native") satisfies object;\nconst I = RN.Image;',
        "probe.ts",
        "reads Image off the react-native module",
      ],
    ])("flags %j in %s", (source, fileName, expectedReason) => {
      expect(coreImageReaches(source, fileName)).toContain(expectedReason);
    });

    it.each([
      // `export type` publishes no runtime value, so a type barrel exposes no component.
      ['export type * from "react-native";', "probe.ts"],
      ['export type { Image } from "react-native";', "probe.ts"],
      ['export { type Image } from "react-native";', "probe.ts"],
    ])("does not flag %j in %s", (source, fileName) => {
      expect(coreImageReaches(source, fileName)).toEqual([]);
    });

    it.each([
      'import { Image as ExpoImage } from "expo-image";\n<ExpoImage source={{ uri }} />',
      'import * as ImagePicker from "expo-image-picker";\nImagePicker.launchCameraAsync();',
      'import { Animated, StyleSheet } from "react-native";\n<Animated.View style={s.x} />',
      // ZoomablePhoto's real shape: an aliased Animated wrapper around an expo-image child.
      'import { Animated as RNAnimated } from "react-native";\nimport { Image as ExpoImage } from "expo-image";\n<RNAnimated.View><ExpoImage source={{ uri }} /></RNAnimated.View>',
      'import { View } from "react-native";\nconst imageUrl = photo.imageUrl;',
      'const { View } = require("react-native");\nconst ImagePicker = require("expo-image-picker");',
      'import { Animated } from "react-native";\nAnimated.createAnimatedComponent(View)',
      // Wrapping expo-image's Image in an animated component is safe — the ARGUMENT is what matters.
      'import { Animated } from "react-native";\nimport { Image } from "expo-image";\nAnimated.createAnimatedComponent(Image)',
      'import { View } from "react-native";\nimport { Image as ExpoImage } from "expo-image";\n<ExpoImage source={{ uri }} />',
      'import { Image as ExpoImage } from "expo-image";\nimport { View } from "react-native";\n<ExpoImage source={{ uri }} />',
      // Comments and strings are trivia — the text-matching implementation flagged all of these.
      'import { View } from "react-native";\n// import { Image } from "react-native";',
      'import { View } from "react-native";\n/* was: <Animated.Image /> before #956 */',
      'import { View } from "react-native";\nconst doc = "import { Image } from \'react-native\'";',
      // A type-only import cannot render.
      'import type { ImageStyle } from "react-native";\nimport { Image } from "expo-image";',
      'import { type ImageSourcePropType, View } from "react-native";',
      // A parameter shadowing a namespace import is a different variable — flagging it would fail the
      // build on code that never touches react-native.
      'import * as RN from "react-native";\nexport function read(RN: Data) { return RN.Image; }',
      'import { Animated } from "react-native";\nexport function f(Animated: X) { return Animated.Image; }',
      // Starring an unrelated react-native subpath exposes no image component.
      'export * from "react-native/Libraries/StyleSheet/StyleSheet";',
      'export { default as StyleSheet } from "react-native/Libraries/StyleSheet/StyleSheet";',
    ])("does not flag %j", (source) => {
      expect(coreImageReaches(source)).toEqual([]);
    });
  });
});
