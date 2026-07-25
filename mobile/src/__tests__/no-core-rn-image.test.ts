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
 * test locks the WHOLE app: any new `import { Image } from "react-native"` fails here. That matters because
 * the first pass of the migration swept `src/components` only and silently left five core <Image> renders
 * in the `app/` route files — including the pending-captures strip on the capture screen itself.
 *
 * To add an allowlist entry you must be able to argue the image can never load asynchronously — in practice
 * that means a statically bundled `require()` asset.
 */

const MOBILE_ROOT = path.resolve(__dirname, "../..");
const SCANNED_DIRS = ["app", "src"];
const SOURCE_EXT = new Set([".ts", ".tsx"]);

/** Files permitted to import a core react-native image component, each with the reason it cannot crash. */
const ALLOWLIST: Record<string, string> = {
  "src/components/BrandLogo.tsx":
    "renders a statically bundled require() PNG — loaded synchronously, never hits the async decode-progress observer path",
};

/** Image components from "react-native" that route through RCTImageManager. */
const CORE_IMAGE_COMPONENTS = new Set(["Image", "ImageBackground"]);

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
function reactNativeImports(contents: string): string[] {
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

describe("no core react-native <Image> outside the allowlist", () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  it("scans the whole mobile source tree", () => {
    // Guards the walker itself: a broken path glob would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/components/BrandLogo.tsx");
    expect(files).toContain("app/(app)/capture.tsx");
  });

  it("renders every runtime photo URI through expo-image", () => {
    const offenders = files
      .filter((file) => !(file in ALLOWLIST))
      .filter((file) =>
        reactNativeImports(fs.readFileSync(path.join(MOBILE_ROOT, file), "utf8")).some((name) =>
          CORE_IMAGE_COMPONENTS.has(name),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    // An allowlisted file that no longer imports a core image component should be dropped from the list,
    // so the list never decays into blanket permission for files nobody has re-checked.
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      const full = path.join(MOBILE_ROOT, file);
      expect(fs.existsSync(full)).toBe(true);
      expect(reason).toBeTruthy();
      expect(reactNativeImports(fs.readFileSync(full, "utf8")).some((n) => CORE_IMAGE_COMPONENTS.has(n))).toBe(true);
    }
  });
});
