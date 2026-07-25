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
 * resolves re-binding within a file (`const A = RN.Animated; <A.Image />`) but cannot follow a core
 * component that leaves a file as an ordinary local export and is imported elsewhere under a new name.
 * It does flag the re-export barrel form (`export { Image } from "react-native"`), which is the practical
 * version of that. Treat green as "no known route", not a proof.
 *
 * An adversarial audit generated 43 candidate evasions and executed each against this implementation.
 * Everything it confirmed against the previous text-matching version is covered here and pinned below,
 * except one: `const RN = require("react-native")` with NO terminating semicolon followed by JSX. That
 * source does not compile — TSX parses `require("react-native")` and the `<` of the next line as a
 * relational expression — so there is nothing to catch.
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
  const base = (specifier.split("/").pop() ?? "").replace(/\.(ios|android|native|web)?\.?[jt]sx?$/, "");
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

/** Strip `await`, parentheses and `as` casts so `(await import("react-native")).Image` reads as a member access. */
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
    return current;
  }
}

/** The accessed member name — `RN.Image` and `RN["Image"]` are the same property read. */
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const arg = node.argumentExpression;
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** Every way this file can reach a core RN image component, as human-readable reasons (empty = clean). */
export function coreImageReaches(contents: string, fileName = "probe.tsx"): string[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) || !/\.[cm]?[jt]s$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, true, kind);

  const reasons = new Set<string>();
  const rnModule = new Set<string>(); // locals holding the whole react-native module
  const rnAnimated = new Set<string>(); // locals holding react-native's Animated
  const coreLocal = new Set<string>(); // locals holding a core Image/ImageBackground component

  /** Does this expression evaluate to the react-native module object? */
  const isRnModuleExpr = (node: ts.Expression): boolean => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) return rnModule.has(expr.text);
    const mod = loaderCallModule(expr);
    return mod !== null && isReactNativeModule(mod);
  };

  /** Does this expression evaluate to react-native's Animated? */
  const isRnAnimatedExpr = (node: ts.Expression): boolean => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) return rnAnimated.has(expr.text);
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

  const readBindingPattern = (pattern: ts.ObjectBindingPattern, origin: "module" | "animated", how: string) => {
    for (const element of pattern.elements) {
      const imported = element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      const local = ts.isIdentifier(element.name) ? element.name.text : imported;
      if (imported && local) bindName(imported, local, origin, how);
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

    // A barrel re-publishes the identical component to every consumer.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      && isReactNativeModule(node.moduleSpecifier.text)) {
      if (!node.exportClause) {
        reasons.add('re-exports all of "react-native" (including Image) from this module');
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (CORE_IMAGE_NAMES.has(imported)) reasons.add(`re-exports ${imported} from "react-native"`);
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

      if (ts.isIdentifier(node.name)) {
        if (fromModule) rnModule.add(node.name.text);
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
  collect(source);
  collect(source);

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
    ])("flags %j", (source, expectedReason) => {
      expect(coreImageReaches(source)).toContain(expectedReason);
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
    ])("does not flag %j", (source) => {
      expect(coreImageReaches(source)).toEqual([]);
    });
  });
});
