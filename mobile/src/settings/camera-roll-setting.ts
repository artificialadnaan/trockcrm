import * as SecureStore from "expo-secure-store";

/**
 * "Save captured photos to the device camera roll" preference.
 *
 * DEFAULT ON: a crew gets a full-res backup of every capture automatically, but can opt out (Profile screen)
 * so jobsite photos don't fill their personal roll. Persisted in expo-secure-store (already a dependency);
 * read per-capture by the fire-and-forget camera-roll save, so a plain async getter is enough (no cache).
 */
const KEY = "settings.saveToCameraRoll";

export async function getSaveToCameraRoll(): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    // Unset → ON (the default). Only an explicit "false" disables it, so a corrupt/legacy value stays ON.
    return raw !== "false";
  } catch {
    // A storage hiccup must never silently DISABLE the backup — fall back to the default (ON).
    return true;
  }
}

export async function setSaveToCameraRoll(value: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, value ? "true" : "false");
  } catch {
    /* best-effort persist; the toggle still reflects the user's choice for this session */
  }
}
