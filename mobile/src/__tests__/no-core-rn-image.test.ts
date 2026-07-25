import fs from "fs";
import path from "path";

/**
 * Tree-wide guard for the Fabric image use-after-free crash (PR #956).
 *
 * React Native's New-Architecture core <Image> crashes the app when it unmounts while an async decode is
 * still in flight — `ImageResponseObserverCoordinator::nativeImageResponseProgress` dereferences an
 * already-freed observer (EXC_BAD_ACCESS at 0x10). Every surface that renders a runtime photo URI
 * (http(s), file://, data:) must therefore use `expo-image`, which has its own native pipeline and never
 * touches RCTImageManager.
 *
 * Per-component "is-it-expo-image" assertions only lock the components that happen to have a test. This
 * test locks the whole tree: any way of reaching the core component fails here. That matters because the
 * first pass of the migration swept `src/components` only and silently left five core <Image> renders in
 * the `app/` route files — including the pending-captures strip on the capture screen itself.
 *
 * `Animated.Image` is checked too, and not as a hypothetical: ZoomablePhoto renders the full-screen photo
 * and already imports `Animated`, and it *was* an `Animated.Image` until PR #888 moved the transform onto
 * an `Animated.View` wrapper. Without this check that file is one edit away from re-introducing the crash
 * with a green suite.
 *
 * To add an allowlist entry you must be able to argue the image can never load asynchronously — in practice
 * that means a statically bundled `require()` asset.
 */

const MOBILE_ROOT = path.resolve(__dirname, "../..");
const SCANNED_DIRS = ["app", "src"];
const SOURCE_EXT = new Set([".ts", ".tsx"]);

/** Files permitted to reach a core react-native image component, each with the reason it cannot crash. */
const ALLOWLIST: Record<string, string> = {
  "src/components/BrandLogo.tsx":
    "renders a statically bundled require() PNG — loaded synchronously, never hits the async decode-progress observer path",
};

/** Image components from "react-native" that route through RCTImageManager. */
const CORE_IMAGE = "(?:Image|ImageBackground)";
const CORE_IMAGE_NAMES = new Set(["Image", "ImageBackground"]);

function sourceFiles(dir: string): string[] {
  const abs = path.join(MOBILE_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (SOURCE_EXT.has(path.extname(entry.name))) out.push(path.relative(MOBILE_ROOT, full));
    }
  };
  walk(abs);
  return out;
}

/**
 * Names a file imports from "react-native", with any `X as Y` alias reduced to the imported name X — an
 * alias still resolves to the crashing core component, so `Image as RNImage` must fail too.
 */
function namedReactNativeImports(contents: string): string[] {
  const names: string[] = [];
  // Multi-line import blocks are the norm in this codebase, so match lazily across newlines.
  const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*["']react-native["']/g;
  for (let match = importBlock.exec(contents); match; match = importBlock.exec(contents)) {
    for (const specifier of match[1].split(",")) {
      const imported = specifier.trim().split(/\s+as\s+/)[0].trim();
      if (imported) names.push(imported);
    }
  }
  return names;
}

/** Local bindings that hold the whole react-native module, so `<binding>.Image` reaches the core component. */
function reactNativeModuleBindings(contents: string): string[] {
  const bindings: string[] = [];
  const patterns = [
    /import\s+\*\s+as\s+(\w+)\s+from\s*["']react-native["']/g, // import * as RN from "react-native"
    /import\s+(\w+)\s*(?:,\s*\{[\s\S]*?\}\s*)?from\s*["']react-native["']/g, // import RN from "react-native"
    /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']react-native["']\s*\)/g, // const RN = require("react-native")
  ];
  for (const pattern of patterns) {
    for (let m = pattern.exec(contents); m; m = pattern.exec(contents)) bindings.push(m[1]);
  }
  return bindings;
}

/** Every way this file can reach a core RN image component, as human-readable reasons (empty = clean). */
function coreImageReaches(contents: string): string[] {
  const reasons: string[] = [];

  for (const name of namedReactNativeImports(contents)) {
    if (CORE_IMAGE_NAMES.has(name)) reasons.push(`imports { ${name} } from "react-native"`);
  }

  // Animated.Image is the same core component with an animated host wrapper — identical crash path.
  for (const hit of contents.match(new RegExp(`\\bAnimated\\.${CORE_IMAGE}\\b`, "g")) ?? []) {
    reasons.push(`renders ${hit}`);
  }

  // Animated.createAnimatedComponent(Image) reaches it without ever writing `Animated.Image`.
  for (const hit of contents.match(new RegExp(`createAnimatedComponent\\(\\s*${CORE_IMAGE}\\b`, "g")) ?? []) {
    reasons.push(`wraps a core image via ${hit.replace(/\s+/g, "")})`);
  }

  // A whole-module binding lets `RN.Image` slip past the named-import check.
  for (const binding of reactNativeModuleBindings(contents)) {
    for (const hit of contents.match(new RegExp(`\\b${binding}\\.${CORE_IMAGE}\\b`, "g")) ?? []) {
      reasons.push(`renders ${hit} via the react-native module binding "${binding}"`);
    }
  }

  return reasons;
}

describe("no core react-native <Image> outside the allowlist", () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  it("scans the whole mobile source tree", () => {
    // Guards the walker itself: a broken path would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/components/BrandLogo.tsx");
    expect(files).toContain("app/(app)/capture.tsx");
  });

  it("renders every runtime photo URI through expo-image", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      if (file in ALLOWLIST) continue;
      const reasons = coreImageReaches(fs.readFileSync(path.join(MOBILE_ROOT, file), "utf8"));
      if (reasons.length > 0) offenders[file] = reasons;
    }

    expect(offenders).toEqual({});
  });

  it("keeps the allowlist honest", () => {
    // An allowlisted file that no longer reaches a core image component should be dropped from the list,
    // so the list never decays into blanket permission for files nobody has re-checked.
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      const full = path.join(MOBILE_ROOT, file);
      expect(fs.existsSync(full)).toBe(true);
      expect(reason).toBeTruthy();
      expect(coreImageReaches(fs.readFileSync(full, "utf8"))).not.toEqual([]);
    }
  });

  describe("the guard itself detects every route to the core component", () => {
    // Without these, a silently-broken regex would let the suite above pass on a crashing tree.
    it.each([
      ['import { Image } from "react-native";', 'imports { Image } from "react-native"'],
      ['import { Image as RNImage } from "react-native";', 'imports { Image } from "react-native"'],
      ['import {\n  View,\n  ImageBackground,\n} from "react-native";', 'imports { ImageBackground } from "react-native"'],
      ['import { Animated } from "react-native";\n<Animated.Image source={{ uri }} />', "renders Animated.Image"],
      [
        'import { Animated, Image } from "react-native";\nAnimated.createAnimatedComponent( Image )',
        "wraps a core image via createAnimatedComponent(Image)",
      ],
      ['import * as RN from "react-native";\n<RN.Image source={{ uri }} />', 'renders RN.Image via the react-native module binding "RN"'],
      ['import RN from "react-native";\n<RN.Image source={{ uri }} />', 'renders RN.Image via the react-native module binding "RN"'],
      [
        'const RN = require("react-native");\n<RN.ImageBackground source={{ uri }} />',
        'renders RN.ImageBackground via the react-native module binding "RN"',
      ],
    ])("flags %j", (source, expectedReason) => {
      expect(coreImageReaches(source)).toContain(expectedReason);
    });

    it.each([
      'import { Image as ExpoImage } from "expo-image";\n<ExpoImage source={{ uri }} />',
      'import * as ImagePicker from "expo-image-picker";\nImagePicker.launchCameraAsync();',
      'import { Animated, StyleSheet } from "react-native";\n<Animated.View style={s.x} />',
      'import { View } from "react-native";\nconst imageUrl = photo.imageUrl;',
    ])("does not flag %j", (source) => {
      expect(coreImageReaches(source)).toEqual([]);
    });
  });
});
