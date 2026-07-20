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

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "T-Rock Cam",
  // Must match the EAS project's slug (project d829c598-…).
  slug: "trockcam",
  scheme: "trockcam",
  version: "1.0.0",
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
      NSPhotoLibraryAddUsageDescription:
        "T-Rock Cam can save captured jobsite photos back to your library.",
      NSLocationWhenInUseUsageDescription:
        "T-Rock Cam tags jobsite photos with their capture location.",
      NSMicrophoneUsageDescription:
        "T-Rock Cam records short voice notes to transcribe photo descriptions.",
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
        // reads the user's library. (NSPhotoLibraryAddUsageDescription is also declared in infoPlist above.)
        savePhotosPermission: "T-Rock Cam saves a backup copy of captured jobsite photos to your camera roll.",
        isAccessMediaLocationEnabled: false,
      },
    ],
    "expo-audio",
  ],
  experiments: {
    typedRoutes: true,
  },
  owner: "adnaan.iqbal",
  extra: {
    eas: { projectId: EAS_PROJECT_ID },
  },
});
