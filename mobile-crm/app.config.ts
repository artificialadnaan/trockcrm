import type { ExpoConfig, ConfigContext } from "expo/config";

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
    eas: { projectId: EAS_PROJECT_ID },
  },
});
