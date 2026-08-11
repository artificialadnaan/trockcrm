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
 * A pairing callback URL that arrived while the SDK could not receive it, held for a retry.
 *
 * In memory only, and that boundary is deliberate rather than overlooked: this survives a failed
 * configure, a screen change and a foreground round trip, which is the span a retry actually happens
 * in. It does not survive the process — and it should not be made to, because a URL replayed into a
 * later launch is a callback the SDK has no pending registration for. A user who gets that far
 * re-taps Pair and Meta issues a fresh one.
 */
let pendingPairingUrl: string | null = null;

/**
 * Every delivery runs on one chain, so a replay can never observe the slot MID-ATTEMPT.
 *
 * `PairingRow.check()` fires on foreground, which is exactly when a warm `url` event is also being
 * delivered. Read without this, the replay could find the slot empty while the delivery it is racing
 * had not yet failed and written to it — passing the only automatic retry point, leaving the callback
 * held with nothing scheduled to hand it over, and the row reporting unpaired glasses until the user
 * happened to background the app again. Serialising also stops two `handleUrl` calls overlapping for
 * the same registration.
 */
let deliveryChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  // Both arms run `task`: a previous delivery's failure must not cancel the next one.
  const run = deliveryChain.then(task, task);
  deliveryChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * The app's OWN routes — `accept-invite` (app/accept-invite.tsx) and `scorecards`
 * (`scorecards/corrective-action/<id>`, src/navigation/return-to.ts).
 *
 * Reached by TWO link forms, which is what makes the parser below scheme-aware rather than a plain
 * split. The custom scheme carries the route in the authority (`trockcam://accept-invite?token=…`);
 * the HTTPS universal link carries it in the PATH, behind a host
 * (`https://<field-host>/accept-invite?token=…`) — that flow is switched on by
 * `EXPO_PUBLIC_FIELD_APP_HOST` via `associatedDomains: applinks:<host>` in app.config.ts, and an
 * emailed invite is exactly how it arrives.
 */
const APP_OWN_ROUTES = new Set(["accept-invite", "scorecards"]);

/**
 * The route key of a deep link, lowercased.
 *
 * For `http(s)` the authority is SKIPPED, because for a universal link the host is the field web
 * host and the route is the first path segment. Reading the authority there returned
 * `field.example.com`, which matches no known route, so an emailed invite counted as retainable and
 * could evict a held Meta callback — the same defect as the custom-scheme invite, one link form over.
 */
function routeKeyOf(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  let rest = (scheme ? url.slice(scheme[0].length) : url).split(/[?#]/)[0] ?? "";
  if (scheme && (scheme[1]?.toLowerCase() === "http" || scheme[1]?.toLowerCase() === "https")) {
    const slash = rest.indexOf("/");
    rest = slash === -1 ? "" : rest.slice(slash + 1);
  }
  return (rest.replace(/^\/+/, "").split("/")[0] ?? "").toLowerCase();
}

/**
 * Whether a URL is worth HOLDING — i.e. whether it is not one of the app's own deep links.
 *
 * A deny-list rather than an allow-list, and the asymmetry is the whole point. The SDK is the
 * authority on what a pairing callback looks like and Meta publishes no stable path for it, so an
 * allow-list guessed from one observed URL would quietly stop retaining the real thing and put back
 * the exact defect this module exists to prevent. The app's own links are a finite, knowable set;
 * everything else is treated as possibly-a-callback and kept.
 *
 * Without this, the root listener — which forwards EVERY incoming URL — would let an invite or a
 * corrective-action link overwrite a held pairing callback, and the later replay would faithfully
 * re-deliver the unrelated link while the glasses stayed unpaired.
 */
export function isRetainablePairingUrl(url: string): boolean {
  return !APP_OWN_ROUTES.has(routeKeyOf(url));
}

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
 * Hand a URL to the SDK, and hold it for a retry if it could be a pairing callback the SDK did not
 * take.
 *
 * Both the cold-launch (`getInitialURL`) and warm (`Linking` url event) paths come through here, so
 * the retention rule cannot be present on one and missing on the other — which is how the original
 * defect was shaped.
 *
 * THREE outcomes count as "not delivered", and all three retain: a failed configure, a `handleUrl`
 * rejection, and a `handleUrl` that RESOLVES `{ handled: false }`. The last is the quietest — the SDK
 * declining a URL without throwing looks identical to success at the call site — and treating it as
 * success would discard the only copy of a callback that never landed.
 */
export function deliverPairingUrl(url: string): Promise<void> {
  return enqueue(async () => {
    const retainable = isRetainablePairingUrl(url);
    const hold = () => {
      if (retainable) pendingPairingUrl = url;
    };

    const configured = await ensureWearablesConfigured();
    if (!configured) {
      hold();
      return;
    }
    try {
      const result = await Wearables.handleUrl(url);
      if (result?.handled) {
        // Pairing got through. Only a HANDLED pairing callback makes a held one stale — an unrelated
        // deep link the SDK happens to accept says nothing about a registration still outstanding.
        if (retainable) pendingPairingUrl = null;
        return;
      }
      hold();
    } catch {
      hold();
    }
  });
}

/**
 * Replay a held callback into a now-configured SDK. Returns whether one was actually delivered.
 *
 * Called from the pairing row after its own successful `configure()` — which runs on mount, on manual
 * refresh and on every foreground — so the retry is something the user reaches by returning to the
 * screen they are already on, rather than a step they have to be told about.
 *
 * Queued behind any in-flight delivery, so a foreground check that coincides with a warm callback
 * sees that attempt's outcome rather than the empty slot it had before it failed.
 *
 * The slot is cleared only when the SDK reports it actually HANDLED the URL. A rejected or declined
 * replay leaves it held for the next attempt; clearing it eagerly would spend the callback on a
 * failure, which is the whole defect this module exists to prevent.
 */
export function deliverPendingPairingUrl(): Promise<boolean> {
  return enqueue(async () => {
    const url = pendingPairingUrl;
    if (!url) return false;
    try {
      const result = await Wearables.handleUrl(url);
      if (!result?.handled) return false;
      pendingPairingUrl = null;
      return true;
    } catch {
      return false;
    }
  });
}

/** Whether a pairing callback is waiting for an SDK that can receive it. */
export function hasPendingPairingUrl(): boolean {
  return pendingPairingUrl !== null;
}
