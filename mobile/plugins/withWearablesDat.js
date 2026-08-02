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
 * Developer Mode: pass metaAppId "0" (the SDK's documented sentinel) to run against
 * MockDeviceKit with no registered app. Production passes the Wearables Developer
 * Center values.
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
// MWDATMockDevice supplies MockDeviceKit, which is how the integration is exercised with
// no glasses and no registered app. The sample guards its import behind #if DEBUG; linking
// it unconditionally is fine, and keeps the package list identical across configurations.
const PRODUCTS = ["MWDATCore", "MWDATCamera", "MWDATMockDevice"];
const ACCESSORY_PROTOCOL = "com.meta.ar.wearable";

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

    // HFP microphone capture from the glasses runs through AVAudioSession, so the app
    // needs its own record permission independent of the DAT camera session.
    plist.NSMicrophoneUsageDescription =
      "T-Rock Cam records your spoken scope notes during a walkthrough, including through Meta glasses.";

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
      requirement: { kind: "upToNextMajorVersion", minimumVersion: opts.version },
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
    metaAppId: options.metaAppId ?? "0",
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
