import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * T-Rock CRM — iOS-only Expo config (dynamic).
 *
 * A SEPARATE app from T-Rock Cam (mobile/): different bundle identifier, different EAS project,
 * different App Store Connect record, different TestFlight. The two share nothing at runtime, including
 * their SecureStore session keys — see src/auth/session.ts.
 *
 * EAS_PROJECT_ID has NO committed default, unlike T-Rock Cam's. The EAS project does not exist yet
 * (`eas init` is a blocked-on-account step), and a placeholder id here would either fail confusingly or,
 * worse, point builds at T-Rock Cam's project. Builds supply it via the environment until it is created.
 *
 * Deliberately minimal plugin set: expo-router, expo-secure-store, expo-font. This app captures nothing —
 * no camera, location, media library or microphone — so it declares no NSUsageDescription for any of
 * them. Every unnecessary permission string is a question at App Review with no feature behind it.
 */
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID?.trim();

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "T-Rock CRM",
  slug: "trockcrm-mobile",
  scheme: "trockcrm",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  // icon/splash are intentionally absent until brand assets exist for THIS app. Expo's defaults apply
  // meanwhile. Reusing mobile/assets would put T-Rock Cam's mark on the CRM app, which is worse than
  // a placeholder. Tracked in README "Before the first TestFlight build".
  ios: {
    bundleIdentifier: "com.trockgc.trockcrm",
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: ["expo-router", "expo-secure-store", "expo-font"],
  experiments: {
    typedRoutes: true,
  },
  owner: "adnaan.iqbal",
  extra: {
    eas: EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : undefined,
  },
});
