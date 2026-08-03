/**
 * The one-shot Meta pairing callback, and the `configure()` it depends on.
 *
 * Registration hands off to the Meta AI app, which returns the user through a `trockcam://` callback
 * URL. That URL is the ONLY notification the SDK ever gets that registration completed: nothing
 * replays it, and Meta does not resend it. Handing it to an SDK that is not configured consumes it
 * for nothing — the glasses stay unpaired, no error surfaces anywhere, and the only way back is for
 * the user to run the whole pairing flow again without ever being told why.
 *
 * This lived inline in `app/_layout.tsx`, where both URL paths called `handleUrl` unconditionally and
 * discarded its rejection. `ensureWearablesConfigured()` resolves even when `configure()` FAILS —
 * deliberately, because a configure failure must never block app launch — so "configuration has been
 * attempted" was being read at the call sites as "the SDK is ready", and a callback arriving after a
 * failed configure was burned. It lives here instead because the policy is worth testing on its own:
 * rendering the root layout to exercise it means standing up fonts, routing, auth and two background
 * task registrations to observe two promises.
 */
import { setStartupConfigureError, Wearables } from "./native";

/**
 * `Wearables.configure()`, started at most once per process and shared by everything that must not
 * run before it.
 *
 * A promise rather than a flag because callers need to WAIT, not merely to know. It never rejects —
 * a configure that fails must not block app launch — and reports the outcome as its VALUE instead,
 * which is the distinction the URL handlers turn on. The cause is retained via
 * `setStartupConfigureError` either way, for `useWalk` to surface when a walk is later refused.
 */
let wearablesConfigurePromise: Promise<boolean> | null = null;

/**
 * A pairing callback URL that arrived while the SDK was not configured, held for a retry.
 *
 * In memory only, and that boundary is deliberate rather than overlooked: this survives a failed
 * configure, a screen change and a foreground round trip, which is the span a retry actually happens
 * in. It does not survive the process — and it should not be made to, because a URL replayed into a
 * later launch is a callback the SDK has no pending registration for. A user who gets that far
 * re-taps Pair and Meta issues a fresh one.
 */
let pendingPairingUrl: string | null = null;

/**
 * Attempt configuration once, and report whether it SUCCEEDED. Never rejects.
 *
 * A failed attempt is not cached as the permanent answer: the memo is cleared once it settles, so the
 * next caller — the next pairing callback, or the pairing row's next foreground check — retries
 * rather than inheriting a failure from launch. `configure()` is idempotent-safe on the native side
 * (guarded on a static `configured` flag, resolving `alreadyConfigured: true`), so a retry costs
 * nothing when it was already fine.
 *
 * The clear happens in a `.then` on the attempt, NOT inside the catch: `Wearables.configure()` throws
 * SYNCHRONOUSLY when the native module is missing, so a catch running inside the async body would
 * clear the memo before the assignment below had even written it, and the failed attempt would then
 * be cached forever — the precise opposite of what it is there for. The identity check keeps a slow
 * failing attempt from clearing a newer one that has already replaced it.
 */
export function ensureWearablesConfigured(): Promise<boolean> {
  if (!wearablesConfigurePromise) {
    const attempt = (async () => {
      try {
        await Wearables.configure();
        // A success CLEARS any cause retained from an earlier failed attempt, so a walk refused later
        // for an unrelated reason is not handed a stale explanation from launch.
        setStartupConfigureError(null);
        return true;
      } catch (error: unknown) {
        setStartupConfigureError(error);
        return false;
      }
    })();
    wearablesConfigurePromise = attempt;
    void attempt.then((configured) => {
      if (!configured && wearablesConfigurePromise === attempt) wearablesConfigurePromise = null;
    });
  }
  return wearablesConfigurePromise;
}

/**
 * Hand a pairing callback URL to the SDK, or hold it until one can actually receive it.
 *
 * Both the cold-launch (`getInitialURL`) and warm (`Linking` url event) paths come through here, so
 * the retention rule cannot be present on one and missing on the other — which is how the original
 * defect was shaped.
 *
 * A rejection from `handleUrl` retains too, not just a failed configure. The loss is identical from
 * the user's side: the callback is spent and registration silently never completed.
 */
export async function deliverPairingUrl(url: string): Promise<void> {
  const configured = await ensureWearablesConfigured();
  if (!configured) {
    pendingPairingUrl = url;
    return;
  }
  try {
    await Wearables.handleUrl(url);
    // Pairing got through. Anything retained from an earlier failure is stale by definition.
    pendingPairingUrl = null;
  } catch {
    pendingPairingUrl = url;
  }
}

/**
 * Replay a retained callback into a now-configured SDK. Returns whether one was actually delivered.
 *
 * Called from the pairing row after its own successful `configure()` — which runs on mount, on manual
 * refresh and on every foreground — so the retry is something the user reaches by returning to the
 * screen they are already on, rather than a step they have to be told about.
 *
 * The slot is cleared only when the SDK ACCEPTS the URL. A rejected replay leaves it retained for the
 * next attempt; clearing it eagerly would spend the callback on a failure, which is the whole defect
 * this module exists to prevent.
 */
export async function deliverPendingPairingUrl(): Promise<boolean> {
  const url = pendingPairingUrl;
  if (!url) return false;
  try {
    await Wearables.handleUrl(url);
    pendingPairingUrl = null;
    return true;
  } catch {
    return false;
  }
}

/** Whether a pairing callback is waiting for a configured SDK. */
export function hasPendingPairingUrl(): boolean {
  return pendingPairingUrl !== null;
}
