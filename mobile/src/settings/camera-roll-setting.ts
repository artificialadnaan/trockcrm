import * as SecureStore from "expo-secure-store";

/**
 * "Save captured photos to the device camera roll" preference.
 *
 * DEFAULT ON: a crew gets a full-res backup of every capture automatically, but can opt out (Profile screen)
 * so jobsite photos don't fill their personal roll. Persisted in expo-secure-store (already a dependency);
 * read per-capture by the fire-and-forget camera-roll save, so a plain async getter is enough (no cache).
 */
const KEY = "settings.saveToCameraRoll";

// In-memory truth for the current app session, set the instant the user toggles. Load-bearing: if
// setItemAsync REJECTS after the user turns the backup OFF, without this the next getSaveToCameraRoll would
// read the stale persisted/default ON and keep saving despite the visible opt-out. Reset only on process
// restart (where the persisted value is authoritative again).
let sessionOverride: boolean | null = null;
// Serialize persists so a slower EARLIER write can't land after a faster LATER one and leave the store stale
// after a restart. FIFO: writes execute in call order → the last toggle wins on disk (in-session reads always
// use sessionOverride regardless).
let persistChain: Promise<unknown> = Promise.resolve();

export async function getSaveToCameraRoll(): Promise<boolean> {
  if (sessionOverride !== null) return sessionOverride;
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
  sessionOverride = value; // honor the choice this session regardless of whether the persist below lands
  const run = () =>
    SecureStore.setItemAsync(KEY, value ? "true" : "false").catch(() => undefined); // best-effort persist
  persistChain = persistChain.then(run, run); // chain onto the tail either way so one failure can't wedge it
  await persistChain;
}

/** Test-only: clear the in-session override + persist chain so each test starts from the persisted/default. */
export function __resetSaveToCameraRollSession(): void {
  sessionOverride = null;
  persistChain = Promise.resolve();
}
