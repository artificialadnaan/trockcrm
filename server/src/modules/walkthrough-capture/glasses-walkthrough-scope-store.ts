// The PRODUCTION wiring of `GlassesWalkthroughScopeReader` — the TROCK Scope port that
// `glasses-walkthrough-scope-service.ts` reads a walkthrough's extracted scope through.
//
// Mirrors `glasses-walkthrough-store.ts` (the object-storage seam one door earlier in the same feature):
// the service module stays free of `fetch` and of `process.env`, so tests inject a fake instead of standing
// up TROCK Scope. Everything that touches the credential lives in this file, which is what makes "the
// browser must never see the token" a property of one small module rather than a habit.
//
// SAME CLIENT SHAPE AS THE WORKER'S, deliberately, and NOT the same code. `scopeRequest` in
// worker/src/jobs/glasses-walkthrough-forward.ts is the established TROCK Scope client in this repo and
// everything structural here is lifted from it: `${baseUrl}${path}` with the trailing slash stripped,
// `Authorization: Bearer <TROCK_SCOPE_SERVICE_TOKEN>`, one `AbortSignal` covering the body read as well as
// the headers, and errors that are re-shaped so nothing holding a reference to the request can be logged.
// It is not imported because it cannot be: `worker` and `server` are separate npm workspaces and the server
// does not depend on the worker (server/package.json), so importing across that boundary would put the
// worker's queue, pool and R2 client into the API's dependency graph to reuse forty lines of fetch.
//
// The two also differ in a way that matters more than the duplication: the worker's client exists to
// classify a WRITE — its whole error taxonomy (`ScopeWalkthroughNotCreatedError`,
// `NEVER_DELIVERED_ERROR_CODES`, the 4xx/5xx split) answers "did my create land?", because guessing wrong
// there buys a second billed transcription. This one performs an idempotent READ, where every failure has
// the same consequence — the panel says "unavailable" and offers a retry — so the only distinction it needs
// is 404 versus everything else. Merging them would mean carrying that taxonomy into a caller that has no
// use for it, and the reverse is worse: a shared client relaxed to suit this side is one whose next change
// silently reopens the duplicate-walkthrough window on the other.
import type { GlassesWalkthroughScopeReader } from "./glasses-walkthrough-scope-service.js";

/**
 * TROCK Scope's read-side scope endpoint (`createReviewRouter`, server/src/routes/review.ts in that repo),
 * mounted under `/api`. Returns `{ items: ScopeItemView[] }` for the walkthrough's OPEN scope items.
 */
function scopeItemsPath(scopeWalkthroughId: string): string {
  // Percent-encoded even though the value is read straight out of a `uuid` column and so cannot contain a
  // path separator. Same reasoning `deriveGlassesWalkthroughArtifactR2Key` gives for encoding its own
  // server-supplied components: a safety property that holds because of a column type in another module is
  // not one this function's next caller can see, and `encodeURIComponent` is the identity over uuids, so it
  // costs nothing to make it local.
  return `/api/walkthroughs/${encodeURIComponent(scopeWalkthroughId)}/scope-items`;
}

/** The walkthrough itself, for the one question `/scope-items` cannot answer: is the pipeline done. */
function walkthroughPath(scopeWalkthroughId: string): string {
  return `/api/walkthroughs/${encodeURIComponent(scopeWalkthroughId)}`;
}

/**
 * The statuses that mean TROCK Scope has STOPPED working on a walkthrough.
 *
 * Read from `WALKTHROUGH_STATUSES` over there: draft / uploading / processing are work in progress;
 * ready / stale / failed are terminal. Only asked when the scope came back EMPTY, so the extra request
 * is paid once per walk that has nothing to show yet rather than on every render.
 *
 * Listing the TERMINAL ones rather than the in-progress ones is deliberate: a status this build has
 * never heard of reads as "still working", which resolves to `processing` and a re-check, instead of
 * as "finished with nothing" — a claim about the estimator's site visit that they would have no reason
 * to doubt.
 */
const TERMINAL_SCOPE_STATUSES = new Set(["ready", "stale", "failed"]);

/**
 * Whether TROCK Scope has stopped working on this walkthrough. BEST EFFORT: never throws.
 *
 * Deliberately NOT sharing the scope-items read's error handling, which is a different contract. That
 * one distinguishes 404 from 5xx from an unreadable body, because each becomes a different state an
 * estimator sees. This one has a single question and a single safe default: anything it cannot
 * establish means "still working", which resolves to `processing` and a re-check. The failure mode it
 * must avoid is claiming a walk FINISHED with no scope, which is a statement about someone's site
 * visit; "give it another moment" costs nothing.
 *
 * Only called when the scope came back empty, so it is one extra request per walk with nothing yet to
 * show, not one per render.
 */
async function pipelineHasFinished(
  baseUrl: string,
  token: string,
  scopeWalkthroughId: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}${walkthroughPath(scopeWalkthroughId)}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) return false;
    const status = (JSON.parse(await response.text()) as { walkthrough?: { status?: unknown } } | null)
      ?.walkthrough?.status;
    return typeof status === "string" && TERMINAL_SCOPE_STATUSES.has(status);
  } catch {
    // Including the abort: a deadline that fired mid-probe is not evidence the pipeline finished.
    return false;
  }
}

/**
 * A function rather than a frozen object literal so `process.env` is read per request — a module-level
 * snapshot would bake in whatever the environment looked like at import time, which is the same reason
 * `createGlassesWalkthroughArtifactStore` evaluates `isR2Configured()` per call.
 *
 * DEPLOY NOTE, because this endpoint is inert without it: `TROCK_SCOPE_BASE_URL` and
 * `TROCK_SCOPE_SERVICE_TOKEN` are set on the CRM **Worker** service today, and not on the **API** service —
 * the forward job was the only thing that had ever needed them. Until an operator sets both on the API,
 * `isConfigured()` is false and every walkthrough that has a scope id reports `unavailable`. That is the
 * correct answer for "we hold no credential", and it is stated here rather than left to be discovered from
 * an empty panel.
 */
export function createGlassesWalkthroughScopeReader(): GlassesWalkthroughScopeReader {
  return {
    isConfigured: () =>
      Boolean(process.env.TROCK_SCOPE_BASE_URL?.trim() && process.env.TROCK_SCOPE_SERVICE_TOKEN?.trim()),

    fetchScopeItems: async (scopeWalkthroughId, signal) => {
      const baseUrl = (process.env.TROCK_SCOPE_BASE_URL ?? "").trim().replace(/\/+$/, "");
      const token = (process.env.TROCK_SCOPE_SERVICE_TOKEN ?? "").trim();
      if (!baseUrl || !token) {
        // Re-checked here and not merely at `isConfigured`, because this method is reachable directly and
        // an empty bearer token is not a harmless no-op — `Authorization: Bearer ` is a credential TROCK
        // Scope has to decide about (see `tokensMatch` in its service-auth middleware, which refuses an
        // empty string precisely so an unset variable cannot authenticate the internet). Throwing keeps
        // this walk at `unavailable`, which is what an absent credential means.
        throw new Error("TROCK Scope is not configured for this process.");
      }

      const path = scopeItemsPath(scopeWalkthroughId);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${token}` },
          // The caller's whole-phase deadline. It covers the BODY read below as well as the request,
          // because `fetch` resolves the moment response headers arrive and a stalled `response.text()`
          // would hang the render just as effectively as a stalled request.
          signal,
        });
      } catch {
        // The rejection is DROPPED, never re-thrown and never hung off `cause`. It is the only object on
        // this path holding a reference to the request, and therefore to the Authorization header — the
        // identical rule the worker's `ScopeRequestTimeoutError` records. What is lost is the undici error
        // code, which the worker needs to tell "never delivered" from "outcome unknown" and this side does
        // not: every failure here is one state, `unavailable`.
        throw new Error(`TROCK Scope did not answer for walkthrough ${scopeWalkthroughId}.`);
      }

      if (response.status === 404) {
        // The one negative claim this reader makes, and it is TROCK Scope's rather than ours. The body is
        // drained so the connection can be reused rather than left half-read.
        await response.text().catch(() => "");
        return { outcome: "missing" };
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new Error(
          `TROCK Scope answered ${response.status} for walkthrough ${scopeWalkthroughId} but the response ` +
            `body could not be read.`
        );
      }

      if (!response.ok) {
        // STATUS ONLY, never the body. TROCK Scope's error envelope is its own to shape and this text is
        // logged by the caller; the status is what distinguishes "it is unhealthy" (5xx) from "it refused
        // our credential" (401/403) from "it does not serve this to a machine principal" — which is today's
        // real case, since GET scope-items is not in that service's SERVICE_ALLOWED_ROUTES allowlist and so
        // answers 403 to the CRM's service token. All three are `unavailable` to the panel; the number is
        // what tells an operator which one they are looking at.
        throw new Error(`TROCK Scope answered ${response.status} for walkthrough ${scopeWalkthroughId}.`);
      }

      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `TROCK Scope answered 200 for walkthrough ${scopeWalkthroughId} with a body that is not JSON.`
        );
      }

      const items = (json as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) {
        // A 200 whose shape we do not recognise is NOT an empty scope. Coercing it to `[]` would render as
        // "this walk produced no line items", which is a claim about the estimator's site visit rather than
        // about our failure to read the answer — and it is unfalsifiable from the panel. `unavailable` is
        // recoverable; a confidently empty scope is what an estimator quietly acts on.
        throw new Error(
          `TROCK Scope answered 200 for walkthrough ${scopeWalkthroughId} without an \`items\` array.`
        );
      }

      if (items.length > 0) return { outcome: "found", items, pipelineComplete: true };

      // EMPTY, so the ambiguous case: ask the walkthrough whether it is finished. A failure here is not
      // fatal — an empty scope we cannot qualify is reported as still-processing, which costs the
      // estimator a re-check and never tells them the machine found nothing when it had not looked yet.
      return {
        outcome: "found",
        items,
        pipelineComplete: await pipelineHasFinished(baseUrl, token, scopeWalkthroughId, signal),
      };
    },
  };
}
