import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * T-Rock Cam — iOS-only Expo config (dynamic so the EAS project id + API base URL
 * can come from the environment without editing tracked source).
 *
 * The only account-bound value is `extra.eas.projectId`. Run `eas init` once to
 * create/bind the project (it prints the id), then either let `eas` manage it or
 * export `EAS_PROJECT_ID` before build/submit. See README.md "First-time EAS setup".
 */
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID ?? "";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "T-Rock Cam",
  slug: "trock-cam",
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
    "expo-audio",
  ],
  experiments: {
    typedRoutes: true,
  },
  owner: "adnaan.iqbal",
  extra: {
    eas: EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : {},
  },
});
