/**
 * Expo config plugin: Meta Wearables Device Access Toolkit (iOS).
 *
 * Everything the DAT SDK needs from the native project, expressed declaratively so it
 * survives `expo prebuild --clean`. Hand-editing ios/ would work exactly once.
 *
 * Two halves:
 *   1. Info.plist — the MWDAT dict, the callback URL scheme, the external-accessory
 *      protocol, Bluetooth background modes and usage strings, and the `fb-viewapp`
 *      query scheme the SDK uses to detect whether Meta AI is installed.
 *   2. pbxproj — the Swift Package Manager dependency. `@expo/config-plugins` has no
 *      helper for SPM, so the four objects Xcode expects are written directly.
 *
 * Developer Mode: metaAppId defaults to "0" (the SDK's documented sentinel), which runs
 * against MockDeviceKit with no registered app. Production passes the Wearables Developer
 * Center values, and `requireRegisteredMetaApp` makes prebuild FAIL rather than let that
 * sentinel reach a shipped build — see resolveMetaAppId.
 */
const {
  withInfoPlist,
  withXcodeProject,
  withDangerousMod,
  withPodfileProperties,
  IOSConfig,
  createRunOncePlugin,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// The bridge has to compile INTO the app target: it imports MWDATCore/MWDATCamera, which are
// Swift Package products attached to that target, and a CocoaPods-built Expo module cannot
// see them. So the sources are copied in and registered on every prebuild instead.
const BRIDGE_FILES = [
  "WearablesBridge.swift",
  "WearablesBridge.m",
  "WalkthroughRecorder.swift",
  "WalkthroughRecorder.m",
];

const PACKAGE_URL = "https://github.com/facebook/meta-wearables-dat-ios";
const DEFAULT_VERSION = "0.8.0";
// See the requirement block in withDatSwiftPackage for why this is MINOR and not MAJOR. Named and
// exported so the choice is assertable — the failure it prevents is a green repo and a red cloud
// build, which no local test would otherwise catch.
const SPM_REQUIREMENT_KIND = "upToNextMinorVersion";
// MWDATMockDevice supplies MockDeviceKit, which is how the integration is exercised with
// no glasses and no registered app. The sample guards its import behind #if DEBUG; linking
// it unconditionally is fine, and keeps the package list identical across configurations.
const PRODUCTS = ["MWDATCore", "MWDATCamera", "MWDATMockDevice"];
const ACCESSORY_PROTOCOL = "com.meta.ar.wearable";

/** The SDK's documented Developer Mode sentinel: MockDeviceKit, no registered app, no real glasses. */
const DEVELOPER_MODE_APP_ID = "0";

/**
 * Decide the MetaAppID, and refuse Developer Mode in a build that is going to real users.
 *
 * The sentinel is a fine default for a dev client — it is how the integration is exercised with no
 * glasses and no Developer Center registration — but it is a silent, total failure in a shipped
 * app: MockDeviceKit answers instead of the real transport, no device is ever eligible, and every
 * walk dies at "no eligible glasses" with nothing on screen pointing at a missing build variable.
 * A failed prebuild is loud, happens on the build machine, and costs minutes; the alternative is
 * discovered by an estimator standing on a job site.
 *
 * Rejects an EXPLICIT "0" as well as a missing value, because the two ship the same broken app —
 * a config that spells out the sentinel for production is a mistake, not consent.
 *
 * Exported for tests: this is a security guard, and the case that matters is the one nobody wants
 * to reproduce by actually cutting a production build.
 */
function resolveMetaAppId({ metaAppId, requireRegisteredMetaApp }) {
  const value = metaAppId == null || String(metaAppId).trim() === "" ? null : String(metaAppId).trim();
  if (requireRegisteredMetaApp && (value === null || value === DEVELOPER_MODE_APP_ID)) {
    throw new Error(
      "withWearablesDat: META_APP_ID is required for a production build.\n\n" +
        `MetaAppID "${DEVELOPER_MODE_APP_ID}" is the Meta Wearables SDK's Developer Mode sentinel — ` +
        "it runs against MockDeviceKit with no registered app, so a shipped build would never see " +
        "a real pair of glasses and every walkthrough would fail at pairing with no explanation.\n" +
        "Set META_APP_ID (and META_CLIENT_TOKEN) from the Wearables Developer Center, or build a " +
        "non-production EAS profile if Developer Mode is what you actually wanted."
    );
  }
  return value ?? DEVELOPER_MODE_APP_ID;
}

/** Deterministic 24-hex pbxproj ids, so a re-run does not churn the project file. */
function stableId(seed) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i) + 7, 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + "000000")
    .slice(0, 24)
    .toUpperCase();
}

const withDatInfoPlist = (config, opts) =>
  withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    const scheme = opts.scheme;

    // The SDK is handed the scheme WITH "://" — the samples use "cameraaccess://".
    plist.MWDAT = {
      AppLinkURLScheme: `${scheme}://`,
      MetaAppID: String(opts.metaAppId),
      ...(opts.clientToken ? { ClientToken: opts.clientToken } : {}),
      TeamID: "$(DEVELOPMENT_TEAM)",
    };

    // Meta AI calls back into the app on this scheme. Expo's top-level `scheme` also
    // registers it, but the SDK requires the entry to exist explicitly.
    plist.CFBundleURLTypes = plist.CFBundleURLTypes ?? [];
    if (!plist.CFBundleURLTypes.some((e) => (e.CFBundleURLSchemes ?? []).includes(scheme))) {
      plist.CFBundleURLTypes.push({
        CFBundleTypeRole: "Editor",
        CFBundleURLName: "$(PRODUCT_BUNDLE_IDENTIFIER)",
        CFBundleURLSchemes: [scheme],
      });
    }

    // Without this the SDK cannot tell whether Meta AI is installed; canOpenURL just
    // returns false and the pairing flow dead-ends with no error.
    plist.LSApplicationQueriesSchemes = Array.from(
      new Set([...(plist.LSApplicationQueriesSchemes ?? []), "fb-viewapp"])
    );

    plist.UISupportedExternalAccessoryProtocols = Array.from(
      new Set([...(plist.UISupportedExternalAccessoryProtocols ?? []), ACCESSORY_PROTOCOL])
    );

    plist.UIBackgroundModes = Array.from(
      new Set([...(plist.UIBackgroundModes ?? []), "bluetooth-peripheral", "external-accessory"])
    );

    plist.NSBluetoothAlwaysUsageDescription =
      plist.NSBluetoothAlwaysUsageDescription ??
      "T-Rock Cam connects to your Meta glasses to capture walkthrough audio and photos.";

    // A walkthrough records narration from THIS PHONE's microphone, never the glasses'. Asking
    // for the glasses over Bluetooth HFP forces their radio into hands-free mode and starves the
    // video transport — measured, video dies after 3-8 seconds — so the recorder deliberately
    // leaves `.allowBluetoothHFP` out. The string must say phone, because a permission prompt that
    // names the glasses describes a capture path this app does not have.
    //
    // Nullish fallback, matching NSBluetoothAlwaysUsageDescription above: `ios.infoPlist` in
    // app.config.ts already declares a microphone string for voice notes on photos, and
    // overwriting it here would let this plugin silently redefine an app-wide permission prompt
    // for a feature that is only one of its users.
    plist.NSMicrophoneUsageDescription =
      plist.NSMicrophoneUsageDescription ??
      "T-Rock Cam records your spoken scope notes through this phone's microphone during a walkthrough.";

    return cfg;
  });

const withDatSwiftPackage = (config, opts) =>
  withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const objects = proj.hash.project.objects;

    const refId = stableId("mwdat-package-ref");
    objects.XCRemoteSwiftPackageReference = objects.XCRemoteSwiftPackageReference ?? {};
    objects.XCRemoteSwiftPackageReference[refId] = {
      isa: "XCRemoteSwiftPackageReference",
      repositoryURL: `"${PACKAGE_URL}"`,
      // upToNextMINOR, not major. The SDK is 0.x, and under SemVer a 0.x MINOR bump is the breaking
      // axis — "up to next major" reads as `>= 0.8.0 < 1.0.0`, which silently accepts every future
      // 0.y. That is not hypothetical: Meta published 0.9.0, SPM resolved it on the next cloud build
      // with no change on our side, and the Swift failed to compile with
      // `value of type 'DeviceSession' has no member 'addStream'` — the bridge and the recorder both
      // target the 0.8.0 API. A floating dependency turned a reproducible build into a dated one.
      // This admits 0.8.x patches and stops at 0.9.0; moving to 0.9 is an API migration, not a bump.
      requirement: { kind: SPM_REQUIREMENT_KIND, minimumVersion: opts.version },
    };
    objects.XCRemoteSwiftPackageReference[`${refId}_comment`] =
      "XCRemoteSwiftPackageReference \"meta-wearables-dat-ios\"";

    objects.XCSwiftPackageProductDependency = objects.XCSwiftPackageProductDependency ?? {};
    const productIds = PRODUCTS.map((product) => {
      const id = stableId(`mwdat-product-${product}`);
      objects.XCSwiftPackageProductDependency[id] = {
        isa: "XCSwiftPackageProductDependency",
        package: refId,
        package_comment: "XCRemoteSwiftPackageReference \"meta-wearables-dat-ios\"",
        productName: product,
      };
      objects.XCSwiftPackageProductDependency[`${id}_comment`] = product;
      return { id, product };
    });

    // Attach to the app target only. Attaching to every target would pull the SDK into
    // the test bundles, where it has nothing to link against.
    const targets = objects.PBXNativeTarget ?? {};
    const appTargetKey = Object.keys(targets).find(
      (key) => !key.endsWith("_comment") && targets[key].productType?.includes("application")
    );
    if (!appTargetKey) throw new Error("withWearablesDat: no application target in the Xcode project");

    const target = targets[appTargetKey];
    target.packageProductDependencies = target.packageProductDependencies ?? [];
    for (const { id, product } of productIds) {
      if (!target.packageProductDependencies.some((d) => (d.value ?? d) === id)) {
        target.packageProductDependencies.push({ value: id, comment: product });
      }
    }

    const rootKey = proj.hash.project.rootObject;
    const root = objects.PBXProject[rootKey];
    root.packageReferences = root.packageReferences ?? [];
    if (!root.packageReferences.some((r) => (r.value ?? r) === refId)) {
      root.packageReferences.push({
        value: refId,
        comment: "XCRemoteSwiftPackageReference \"meta-wearables-dat-ios\"",
      });
    }

    return cfg;
  });

/**
 * Set DEVELOPMENT_TEAM in build settings.
 *
 * Prebuild does not carry the team over from eas.json, so a fresh ios/ has it unset. That
 * breaks device signing, and it also silently empties `MWDAT.TeamID`, which is written as
 * `$(DEVELOPMENT_TEAM)` and substituted by Xcode at build time — the SDK would receive a
 * blank team with no indication why.
 */
const withDevelopmentTeam = (config, teamId) =>
  withXcodeProject(config, (cfg) => {
    if (!teamId) return cfg;
    cfg.modResults.updateBuildProperty("DEVELOPMENT_TEAM", teamId);
    return cfg;
  });

/**
 * Raise the iOS deployment target to what MWDATCore actually requires.
 *
 * Expo SDK 54's default deployment target is 15.1; MWDATCore requires 15.2 (see the design doc,
 * docs/superpowers/specs/2026-07-30-glasses-capture-design.md). Below that floor the SDK's minimum is
 * silently unmet on modern build/test hardware (which is always >= 15.2 anyway) but a genuine 15.1
 * device fails to LAUNCH the app outright — not a graceful degradation. This constraint originates from
 * MWDAT, so it belongs on this plugin (which already owns the MWDAT integration) rather than pulling in
 * a whole new `expo-build-properties` dependency for one value.
 *
 * Two independent places need it — Expo's template Podfile and the Xcode project each keep their own
 * copy of the deployment target, and only setting one leaves the other silently at 15.1:
 *   - Podfile.properties.json's `ios.deploymentTarget`: the generated Podfile already does
 *     `platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'`, so writing this key alone
 *     raises the floor every Pod (including Expo's own modules) builds against.
 *   - `IPHONEOS_DEPLOYMENT_TARGET` in the Xcode project's build settings, every target/configuration
 *     (mirrors `withDevelopmentTeam` below, which uses the same all-targets `updateBuildProperty` call) —
 *     this is what actually becomes the app's `MinimumOSVersion` at build time, which is the number that
 *     decides whether a 15.1 device can launch the app at all.
 */
const MIN_IOS_DEPLOYMENT_TARGET = "15.2";

const withIosDeploymentTarget = (config, target) => {
  let next = withPodfileProperties(config, (cfg) => {
    cfg.modResults["ios.deploymentTarget"] = target;
    return cfg;
  });
  next = withXcodeProject(next, (cfg) => {
    cfg.modResults.updateBuildProperty("IPHONEOS_DEPLOYMENT_TARGET", target);
    return cfg;
  });
  return next;
};

/** Copy the bridge sources next to AppDelegate so Xcode can compile them in-target. */
const withBridgeSources = (config) =>
  withDangerousMod(config, [
    "ios",
    (cfg) => {
      const projectName = cfg.modRequest.projectName;
      const destDir = path.join(cfg.modRequest.platformProjectRoot, projectName);
      const srcDir = path.join(cfg.modRequest.projectRoot, "plugins", "wearables-native");
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of BRIDGE_FILES) {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
      }
      return cfg;
    },
  ]);

/** Register the copied sources in the target's Sources build phase. */
const withBridgeInTarget = (config) =>
  withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName;
    for (const file of BRIDGE_FILES) {
      const relative = `${projectName}/${file}`;
      if (cfg.modResults.hasFile(relative)) continue;
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: relative,
        groupName: projectName,
        project: cfg.modResults,
      });
    }
    return cfg;
  });

const withWearablesDat = (config, options = {}) => {
  const opts = {
    scheme: options.scheme ?? config.scheme ?? "trockcam",
    // Throws on a production config with no registered app — see resolveMetaAppId. Deliberately
    // evaluated here, at the top of the plugin, so prebuild fails before a single file is written
    // rather than leaving a half-configured ios/ behind.
    metaAppId: resolveMetaAppId({
      metaAppId: options.metaAppId,
      requireRegisteredMetaApp: options.requireRegisteredMetaApp === true,
    }),
    clientToken: options.clientToken ?? null,
    version: options.version ?? DEFAULT_VERSION,
    appleTeamId: options.appleTeamId ?? null,
  };
  // Order matters: sources must exist on disk before they are referenced in the pbxproj.
  let next = withDatInfoPlist(config, opts);
  next = withDatSwiftPackage(next, opts);
  next = withBridgeSources(next);
  next = withBridgeInTarget(next);
  next = withDevelopmentTeam(next, opts.appleTeamId);
  next = withIosDeploymentTarget(next, MIN_IOS_DEPLOYMENT_TARGET);
  return next;
};

module.exports = createRunOncePlugin(withWearablesDat, "withWearablesDat", "1.0.0");
// Named exports hang off the plugin function itself; Expo resolves the module's default export
// (the function) and ignores everything else, so this is invisible to prebuild and reachable
// from a unit test.
module.exports.resolveMetaAppId = resolveMetaAppId;
module.exports.DEVELOPER_MODE_APP_ID = DEVELOPER_MODE_APP_ID;
module.exports.SPM_REQUIREMENT_KIND = SPM_REQUIREMENT_KIND;
module.exports.DEFAULT_VERSION = DEFAULT_VERSION;
