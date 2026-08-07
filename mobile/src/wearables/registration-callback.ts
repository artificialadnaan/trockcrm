import * as Linking from "expo-linking";
import { Wearables } from "./native";

/**
 * The Meta registration callback, handled from APP STARTUP rather than from the diagnostic screen.
 *
 * `startRegistration()` hands off to Meta AI, which returns on `trockcam://`. The SDK only learns the
 * outcome if that URL reaches `handleUrl()`. The screen used to own that, and for a WARM return it
 * works — the app is already running with the screen mounted.
 *
 * A COLD return is the case it cannot serve. iOS may terminate the app during the handoff, and the
 * callback URL is then what launches it: expo-router treats that URL as the initial route, which is
 * not `/dev-wearables`, so the screen never mounts and `getInitialURL()` is never called. Registration
 * silently never completes, and every later rung fails with "No eligible device" — an error naming the
 * glasses when the real cause was a listener that was not installed yet.
 *
 * Installed as a startup side effect for the same reason `upload-background-task` is: the work has to
 * be reachable before any screen has decided to exist. Same file, same pattern.
 *
 * DEV ONLY. This is the diagnostic's plumbing, and a release build has no screen to serve.
 */

type CallbackRecord = { url: string; handled: boolean | null; error: string | null };

let last: CallbackRecord | null = null;
const listeners = new Set<(record: CallbackRecord) => void>();
let installed = false;

function record(next: CallbackRecord) {
  last = next;
  for (const listener of listeners) listener(next);
}

/** The most recent callback seen since launch, including one that arrived before any screen mounted. */
export function getLastRegistrationCallback(): CallbackRecord | null {
  return last;
}

export function subscribeToRegistrationCallback(
  listener: (record: CallbackRecord) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hands a callback URL to the SDK and records the outcome. Exported so the warm path shares it. */
export function handleRegistrationCallback(url: string): void {
  record({ url, handled: null, error: null });
  Wearables.handleUrl(url)
    .then((result) => record({ url, handled: result.handled, error: null }))
    .catch((error) => record({ url, handled: false, error: String(error) }));
}

/**
 * Idempotent: the module is imported for its side effect, but an explicit call from a screen must not
 * re-consume the launch URL. `getInitialURL()` returns the URL that LAUNCHED the app, so handling it
 * twice would re-submit a callback the SDK has already seen.
 */
export function installRegistrationCallbackHandler(): void {
  if (installed || !__DEV__) return;
  installed = true;
  void Linking.getInitialURL().then((url) => {
    if (url) handleRegistrationCallback(url);
  });
}

installRegistrationCallbackHandler();
