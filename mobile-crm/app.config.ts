import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * The location prompt, in one place.
 *
 * iOS shows this verbatim, and it has to be set twice — see the plugin block below. Two literals with a
 * comment saying they must match is exactly the arrangement that drifts.
 */
const LOCATION_PERMISSION_COPY =
  "T-Rock CRM uses your location only while you are logging a site visit, to find the property you are standing at instead of making you type its address.";

/**
 * T-Rock CRM — iOS-only Expo config (dynamic).
 *
 * A SEPARATE app from T-Rock Cam (mobile/): different bundle identifier, different EAS project,
 * different App Store Connect record, different TestFlight. The two share nothing at runtime, including
 * their SecureStore session keys — see src/auth/session.ts.
 *
 * EAS_PROJECT_ID is committed as a default, matching T-Rock Cam. It is an identifier, not a secret, and
 * it HAS to be committed: EAS evaluates this config on its own build servers, where the environment
 * variable cannot be set — knowing which project's variables to load is precisely what the id is for.
 * The env var remains an override for anyone pointing a build at a different project.
 *
 * It had no default until the project existed (`eas init`, 2026-07-27), because a placeholder would have
 * failed confusingly or, worse, aimed builds at T-Rock Cam's project.
 *
 * Deliberately minimal plugin set: expo-router, expo-secure-store, expo-font. This app captures nothing —
 * no camera, location, media library or microphone — so it declares no NSUsageDescription for any of
 * them. Every unnecessary permission string is a question at App Review with no feature behind it.
 */
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID?.trim() || "129671d5-0cdb-4df5-992e-91301502bb99";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "T-Rock CRM",
  slug: "trockcrm-mobile",
  scheme: "trockcrm",
  version: "1.0.0",
  orientation: "portrait",
  /**
   * DARK, matching the UI.
   *
   * This drives the NATIVE surfaces the app does not draw: the keyboard, system alerts, text-selection
   * handles, the share sheet and the scroll indicators. Left on "light" they render as bright panels
   * over a near-black app — the keyboard in particular is a white slab covering half the screen, which
   * no amount of styling on our side can fix. Flipping the status-bar glyphs alone was treating one
   * symptom of this.
   */
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  /**
   * The T-Rock mark, 1024x1024 and OPAQUE.
   *
   * No alpha channel on purpose: App Store Connect rejects an icon that has one, and it rejects
   * pre-rounded corners too — iOS applies its own mask, so the artwork is a full-bleed square and the
   * mark carries its own padding to survive that crop.
   *
   * Its own copy under mobile-crm/assets rather than a path into mobile/assets. The two apps are
   * separate Expo projects with separate EAS builds, and a shared asset would mean a T-Rock Cam brand
   * change silently re-skinning the CRM app on its next build.
   */
  icon: "./assets/icon.png",
  /**
   * backgroundColor MATCHES the artwork's own background (verified pure #000000 to the edge).
   *
   * `contain` letterboxes a square image on a tall screen and fills the remainder with this colour, so
   * any other value would frame the splash with a visible black square instead of reading as one
   * surface. The app itself is light (userInterfaceStyle above); the brand mark is not.
   */
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#000000",
  },
  ios: {
    bundleIdentifier: "com.trockgc.trockcrm",
    // Declared HERE as well as at the top level, matching T-Rock Cam: the platform key is what iOS
    // actually builds from, and a top-level-only icon has silently fallen back to Expo's default.
    icon: "./assets/icon.png",
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSLocationWhenInUseUsageDescription: LOCATION_PERMISSION_COPY,
    },
  },
  plugins: [
    "expo-router",
    // Required by expo install: the picker ships native code, so it needs a config plugin entry to be
    // linked into the prebuild rather than only appearing in package.json.
    "@react-native-community/datetimepicker",
    "expo-secure-store",
    "expo-font",
    [
      "expo-location",
      {
        // Set in BOTH places because the config plugin writes the Info.plist entry on prebuild while
        // the infoPlist block applies when the value is set directly — so which one wins depends on how
        // the build was produced. One constant, because two literals that "must stay identical" drift.
        locationWhenInUsePermission: LOCATION_PERMISSION_COPY,
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
