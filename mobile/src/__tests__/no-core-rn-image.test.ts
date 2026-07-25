import fs from "fs";
import path from "path";

/**
 * Tree-wide guard for the Fabric image use-after-free crash (PR #956).
 *
 * `ImageResponseObserverCoordinator::nativeImageResponseProgress` snapshots `observers_` under its mutex,
 * unlocks, and *then* dereferences those RAW observer pointers. If a core RN <Image> unmounts in that
 * window, the observer is already destroyed → EXC_BAD_ACCESS at 0x10. So no source file may reach a core
 * react-native image component, by any route.
 *
 * There is NO allowlist, deliberately. The obvious exemption — "it's a statically bundled require() asset,
 * so it loads synchronously" — is FALSE on Fabric: `RCTImageManager::requestImage` dispatch_asyncs *every*
 * request onto its background serial queue, and `RCTBundleAssetImageLoader` still fires
 * `progressHandler(1, 1)` from there, reaching the same coordinator. BrandLogo was exempted on exactly
 * that bad premise and has since been migrated. If you think you have found a safe exception, re-read
 * RCTImageManager.mm first.
 *
 * Per-component "is-it-expo-image" assertions only lock the components that happen to have a test — which
 * is why the first pass of this migration swept `src/components` only and silently left five core <Image>
 * renders in the `app/` route files, including the pending-captures strip on the capture screen itself.
 * `mobile/app` route files have no render tests at all, so a tree-wide static check is the only thing that
 * can cover them.
 *
 * `Animated.Image` is checked too, and not hypothetically: ZoomablePhoto renders the full-screen photo,
 * already imports `Animated`, and *was* an `Animated.Image` until PR #888 moved the transform onto an
 * `Animated.View` wrapper.
 */

const MOBILE_ROOT = path.resolve(__dirname, "../..");
const SCANNED_DIRS = ["app", "src"];
const SOURCE_EXT = new Set([".ts", ".tsx"]);

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

/** Split a `{ a, b as c }` binding list into the ORIGINAL names — an alias still resolves to the core component. */
function destructuredNames(braceBody: string): string[] {
  return braceBody
    .split(",")
    .map((specifier) => specifier.trim().split(/\s+as\s+|:/)[0].trim())
    .filter(Boolean);
}

/** Names a file pulls out of "react-native", via either `import { … }` or `const { … } = require(…)`. */
function namedReactNativeBindings(contents: string): string[] {
  const names: string[] = [];
  const patterns = [
    // Multi-line import blocks are the norm in this codebase, so match lazily across newlines.
    /import\s*\{([\s\S]*?)\}\s*from\s*["']react-native["']/g,
    /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*require\(\s*["']react-native["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (let m = pattern.exec(contents); m; m = pattern.exec(contents)) names.push(...destructuredNames(m[1]));
  }
  return names;
}

/** Local bindings holding the whole react-native module, so `<binding>.Image` reaches the core component. */
function reactNativeModuleBindings(contents: string): string[] {
  const bindings: string[] = [];
  const patterns = [
    /import\s+\*\s+as\s+(\w+)\s+from\s*["']react-native["']/g, // import * as RN from "react-native"
    /import\s+(\w+)\s*(?:,\s*\{[\s\S]*?\}\s*)?from\s*["']react-native["']/g, // import RN from "react-native"
    /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']react-native["']\s*\)\s*[;\n]/g, // const RN = require("react-native")
  ];
  for (const pattern of patterns) {
    for (let m = pattern.exec(contents); m; m = pattern.exec(contents)) bindings.push(m[1]);
  }
  return bindings;
}

/** Every way this file can reach a core RN image component, as human-readable reasons (empty = clean). */
export function coreImageReaches(contents: string): string[] {
  const reasons: string[] = [];

  for (const name of namedReactNativeBindings(contents)) {
    if (CORE_IMAGE_NAMES.has(name)) reasons.push(`binds ${name} from "react-native"`);
  }

  // Animated.Image is the same core component with an animated host wrapper — identical crash path.
  for (const hit of contents.match(new RegExp(`\\bAnimated\\.${CORE_IMAGE}\\b`, "g")) ?? []) {
    reasons.push(`renders ${hit}`);
  }

  // Animated.createAnimatedComponent(Image) reaches it without ever writing `Animated.Image`.
  for (const hit of contents.match(new RegExp(`createAnimatedComponent\\(\\s*${CORE_IMAGE}\\b`, "g")) ?? []) {
    reasons.push(`wraps a core image via ${hit.replace(/\s+/g, "")})`);
  }

  // `require("react-native").Image` — no binding to find, the member access IS the reach.
  for (const hit of contents.match(new RegExp(`require\\(\\s*["']react-native["']\\s*\\)\\.${CORE_IMAGE}\\b`, "g")) ?? []) {
    reasons.push(`reads .${hit.split(".").pop()} off require("react-native")`);
  }

  // A whole-module binding lets `RN.Image` slip past the named-binding check.
  for (const binding of reactNativeModuleBindings(contents)) {
    for (const hit of contents.match(new RegExp(`\\b${binding}\\.${CORE_IMAGE}\\b`, "g")) ?? []) {
      reasons.push(`renders ${hit} via the react-native module binding "${binding}"`);
    }
  }

  return reasons;
}

describe("no core react-native <Image> anywhere", () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  it("scans the whole mobile source tree", () => {
    // Guards the walker itself: a broken path would make the assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/components/BrandLogo.tsx");
    expect(files).toContain("app/(app)/capture.tsx");
  });

  it("renders every image through expo-image", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      const reasons = coreImageReaches(fs.readFileSync(path.join(MOBILE_ROOT, file), "utf8"));
      if (reasons.length > 0) offenders[file] = reasons;
    }

    expect(offenders).toEqual({});
  });

  describe("the guard itself detects every route to the core component", () => {
    // Without these, a silently-broken regex would let the assertion above pass on a crashing tree.
    it.each([
      ['import { Image } from "react-native";', 'binds Image from "react-native"'],
      ['import { Image as RNImage } from "react-native";', 'binds Image from "react-native"'],
      ['import {\n  View,\n  ImageBackground,\n} from "react-native";', 'binds ImageBackground from "react-native"'],
      ['const { Image } = require("react-native");', 'binds Image from "react-native"'],
      ['const { Image: RNImage } = require("react-native");', 'binds Image from "react-native"'],
      ['const Img = require("react-native").Image;', 'reads .Image off require("react-native")'],
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
      'const { View } = require("react-native");\nconst ImagePicker = require("expo-image-picker");',
    ])("does not flag %j", (source) => {
      expect(coreImageReaches(source)).toEqual([]);
    });
  });
});
