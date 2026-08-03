import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * T-Rock Cam — iOS-only Expo config (dynamic).
 *
 * EAS project id is bound to the created project (overridable via EAS_PROJECT_ID).
 *
 * Universal links: set EXPO_PUBLIC_FIELD_APP_HOST to the field web host (e.g.
 * field.<domain>) so emailed HTTPS invites (FIELD_APP_URL + /accept-invite?token=)
 * open the native accept-invite route. This also requires the backend to serve an
 * apple-app-site-association file at that host (server-side; not in this lane).
 * Without it, the custom `trockcam://` scheme still works and the HTTPS invite
 * falls back to the web accept-invite page.
 */
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID ?? "d829c598-4767-40cf-ba32-2441bd406221";
const FIELD_APP_HOST = process.env.EXPO_PUBLIC_FIELD_APP_HOST?.trim();

/**
 * Whether this build is the one that reaches real users.
 *
 * EAS Build sets EAS_BUILD_PROFILE to the eas.json profile being built — "production",
 * "preview", "development", "development-device". A local `expo prebuild` sets nothing, which
 * reads as non-production, and that is the right default: a developer's machine is exactly where
 * mock/dev credentials belong.
 *
 * This is the only production signal available while this file runs. `__DEV__` is a bundler
 * constant that does not exist in Node, and NODE_ENV is not something EAS sets — so anything that
 * must differ between a dev client and a shipped build has to key off this.
 */
const IS_PRODUCTION_BUILD = process.env.EAS_BUILD_PROFILE === "production";

// `require`, and a `.js` module, for the same reason the plugins array names its plugin by
// string: Expo transpiles THIS file but requires what it imports as-is, so a `.ts` sibling
// cannot be loaded — it makes `expo config` exit non-zero with no output at all.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertProductionBuildEnv } = require("./plugins/assert-production-build-env") as {
  assertProductionBuildEnv: (env: NodeJS.ProcessEnv, isProductionBuild: boolean) => void;
};

// Fails the BUILD rather than shipping one that installs and cannot reach the CRM. The Meta
// credentials are already treated this way below (`requireRegisteredMetaApp`); this is the same
// rule for the API host, which is the other half of what a production build has to be told.
assertProductionBuildEnv(process.env, IS_PRODUCTION_BUILD);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "T-Rock Cam",
  // Must match the EAS project's slug (project d829c598-…).
  slug: "trockcam",
  scheme: "trockcam",
  version: "1.0.0",
  // iOS only, in fact and not just by convention: react-native-web is not a dependency, so
  // Metro's default ["ios","android","web"] makes every web bundle attempt fail noisily and
  // for no reason. The ios block below is already the only platform block in this config.
  platforms: ["ios"],
  orientation: "portrait",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  icon: "./assets/icon.png",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#15181D",
  },
  // iOS-only: no `android` block is declared anywhere in this project.
  ios: {
    bundleIdentifier: "com.trockgc.trockcam",
    icon: "./assets/icon.png",
    supportsTablet: false,
    // Enables HTTPS universal-link invite onboarding when the field host is set
    // (and the backend serves apple-app-site-association). No-op otherwise.
    associatedDomains: FIELD_APP_HOST ? [`applinks:${FIELD_APP_HOST}`] : undefined,
    infoPlist: {
      // Field photos can be large batches; allow background-friendly networking.
      ITSAppUsesNonExemptEncryption: false,
      NSCameraUsageDescription:
        "T-Rock Cam uses the camera to capture jobsite photos and attach them to a project.",
      NSPhotoLibraryUsageDescription:
        "T-Rock Cam imports photos from your library to attach them to a project.",
      // NSPhotoLibraryAddUsageDescription is provided by the expo-media-library plugin (savePhotosPermission,
      // below) — declaring it here too is dead config (the plugin value wins).
      NSLocationWhenInUseUsageDescription:
        "T-Rock Cam tags jobsite photos with their capture location.",
      // Covers BOTH microphone uses, because iOS shows this string once and then never again: the
      // original short voice notes on a photo, and an AI walk, where the phone's mic records the
      // entire narration for the length of the walk. A consent string that only mentions "short
      // voice notes" is asking for the wrong thing — someone granting it has not been told the app
      // may record them continuously for twenty minutes.
      NSMicrophoneUsageDescription:
        "T-Rock Cam records your voice — short notes on a photo, and the full narration during an " +
        "AI walk, which is what the scope is written from.",
    },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-font",
    // Registers the iOS BGTaskScheduler identifier + background mode so the field upload queue can drain
    // opportunistically after the app is backgrounded mid-batch (best-effort; iOS grants short windows).
    "expo-background-task",
    [
      "expo-image-picker",
      {
        photosPermission: "Attach jobsite photos from your library to a project.",
        cameraPermission: "Capture jobsite photos to attach to a project.",
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission: "Tag jobsite photos with their capture location.",
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Capture jobsite photos to attach to a project.",
      },
    ],
    [
      "expo-media-library",
      {
        // Write-only: T-Rock Cam only ADDS a backup copy of captured photos to the camera roll; it never
        // reads the user's library. This savePhotosPermission is the SINGLE source of
        // NSPhotoLibraryAddUsageDescription (not duplicated in infoPlist).
        savePhotosPermission: "T-Rock Cam saves a backup copy of captured jobsite photos to your camera roll.",
        isAccessMediaLocationEnabled: false,
      },
    ],
    "expo-audio",
    [
      // Meta Wearables Device Access Toolkit. MetaAppID "0" selects Developer Mode, which
      // runs against MockDeviceKit with no registered app — set META_APP_ID and
      // META_CLIENT_TOKEN from the Wearables Developer Center to talk to real glasses.
      "./plugins/withWearablesDat",
      {
        scheme: "trockcam",
        // Left undefined rather than defaulted to "0" here: the plugin owns the sentinel, and
        // handing it one already resolved would make the production guard below unable to tell a
        // deliberate Developer Mode config from an unset environment variable.
        metaAppId: process.env.META_APP_ID,
        clientToken: process.env.META_CLIENT_TOKEN ?? null,
        // Fail prebuild rather than ship Developer Mode. Without a registered app the SDK answers
        // from MockDeviceKit, so a released build finds no glasses at all and every walkthrough
        // dies at pairing — a failure that costs an estimator a site visit to discover, and that
        // nothing in the running app can attribute to a missing build variable.
        requireRegisteredMetaApp: IS_PRODUCTION_BUILD,
        // Prebuild does not carry the team over from eas.json; without it, device signing
        // fails and MWDAT.TeamID resolves to an empty string.
        appleTeamId: process.env.APPLE_TEAM_ID ?? "WKX5A3KC28",
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  owner: "adnaan.iqbal",
  extra: {
    eas: { projectId: EAS_PROJECT_ID },
  },
});
