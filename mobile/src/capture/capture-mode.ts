import * as SecureStore from "expo-secure-store";

/**
 * How the live camera behaves on each shutter tap:
 *  - "perPhoto": after every shot, the per-photo note editor auto-appears so the
 *    crew documents that photo in the moment, then returns to the camera (default).
 *  - "batch": shots accumulate silently; captions are added afterward in the
 *    review tray (the original burst flow).
 * Persisted across launches so a crew's preference sticks.
 */
export type CaptureMode = "perPhoto" | "batch";

export const DEFAULT_CAPTURE_MODE: CaptureMode = "perPhoto";

const KEY = "trockcam.captureMode";

export async function loadCaptureMode(): Promise<CaptureMode> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw === "batch" || raw === "perPhoto" ? raw : DEFAULT_CAPTURE_MODE;
  } catch {
    // A storage read failure must never block capture — fall back to the default.
    return DEFAULT_CAPTURE_MODE;
  }
}

export async function saveCaptureMode(mode: CaptureMode): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, mode);
  } catch {
    // Non-fatal: the choice still applies for this session, just isn't remembered.
  }
}
