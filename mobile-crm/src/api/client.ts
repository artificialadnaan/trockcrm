import { API_BASE_URL, API_BASE_URL_MISSING_MESSAGE } from "../config";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export type ApiFetchOptions = {
  /** Bearer JWT (from the CRM mobile session). */
  token?: string | null;
  /** Active office id → sent as `x-office-id` (tenant routing). */
  officeId?: string | null;
  method?: string;
  /** JSON-serializable request body. */
  body?: unknown;
  query?: QueryParams;
  /**
   * Called ONLY on 401 (authentication failure — token missing/expired/invalid) so the caller can
   * clear the session and re-prompt login. NOT called on 403: a 403 is an *authorization* failure
   * (CSRF/RBAC/permission on a specific action), not a dead session — surfacing it as an error must
   * not sign the user out.
   */
  onUnauthorized?: () => void;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function buildQuery(query?: QueryParams): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * The single JSON HTTP client for the CRM API. Ported from T-Rock Cam's client (mobile/src/api/client.ts)
 * — same transport contract, retargeted at the CRM surface.
 *
 *  - `Authorization: Bearer <jwt>` from POST /api/auth/mobile-login. This client is Bearer-ONLY and
 *    never sets a cookie, which is what keeps it outside the server's cookie-triggered CSRF gate: that
 *    gate engages only when a `token` cookie is present on an unsafe request.
 *  - `x-office-id` for multi-office tenant routing. Load-bearing: offices are SEPARATE POSTGRES SCHEMAS
 *    (the server sets search_path per request), so sending the wrong id silently returns another
 *    office's data rather than an error.
 *  - `x-requested-with: XMLHttpRequest` on unsafe methods. On the FIELD surface this header IS the CSRF
 *    gate; on CRM routes it is not consulted, so here it is defence-in-depth only — harmless, and correct
 *    if this client ever acquires a cookie (RN's fetch shares the system cookie store).
 */
export async function apiFetch<T = unknown>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const {
    token,
    officeId,
    method = "GET",
    body,
    query,
    onUnauthorized,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = opts;

  // Fail fast and clearly when the host wasn't configured (see config.ts) — at call time rather than
  // import time so the UI can render and surface it.
  if (!API_BASE_URL) throw new ApiError(API_BASE_URL_MISSING_MESSAGE, 0);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (officeId) headers["x-office-id"] = officeId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE_METHODS.has(method.toUpperCase())) headers["x-requested-with"] = "XMLHttpRequest";

  const controller = new AbortController();
  // Both the timeout and a caller's own signal abort the SAME controller, so `controller.signal.aborted`
  // alone cannot say which fired — and reporting a deliberate unmount cancellation as "Request timed out"
  // sends screens down an error path for something that is not an error. Track the cause explicitly.
  let timedOut = false;
  // Armed only once the headers are in — see the body deadline below.
  let bodyTimedOut = false;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // The listener is RETAINED so it can be removed when the request settles. `{ once: true }` only
  // detaches after the event fires — a request that completes normally leaves it attached forever, so a
  // caller reusing one long-lived signal across many requests accumulates a listener per request.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // The abort listener is removed in an OUTER finally so it stays live through the BODY read, not
  // just the headers. A caller that aborts while a slow or large body is still streaming was
  // previously ignored: the listener had already been detached when fetch() resolved, so the
  // internal controller never saw the abort and the read ran to completion. That mattered more once
  // a failed body read stopped being reported as a successful-but-malformed response — the
  // cancellation path below can only classify an abort it actually received.
  try {
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}/api${path}${buildQuery(query)}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      if (timedOut) throw new ApiError("Request timed out", 408);
      // Caller-initiated cancellation. Status 0 keeps it in the transport-failure bucket callers already
      // handle, with a message that does not claim the server was slow.
      if (controller.signal.aborted) throw new ApiError("Request cancelled", 0);
      // Wrap transport-level failures (offline, DNS, refused) as ApiError(0) so
      // callers only ever handle one error type.
      throw new ApiError(e instanceof Error ? e.message : "Network request failed", 0);
    } finally {
      // The HEADER timer stops here and a fresh BODY timer is armed below. Two deadlines rather than
      // one, because they measure different things: this one is time-to-response, and the server has
      // now answered.
      clearTimeout(timer);
    }

    /**
     * The body gets its own deadline.
     *
     * Clearing the header timer and arming nothing left `res.json()` able to hang FOREVER: a connection
     * that goes away mid-body — the common job-site case, where the radio drops between the headers and
     * the payload — produces a promise that neither resolves nor rejects, and the screen sits on a
     * spinner with no timeout, no error, and no retry. Worse than the failure it replaced.
     *
     * A full fresh budget rather than the remainder of the original: this client only ever reads JSON,
     * so a body that needs longer than the whole request budget is pathological, and giving it its own
     * window keeps a nearly-exhausted header phase from cutting off a payload that is arriving fine.
     */
    bodyTimedOut = false;
    bodyTimer = setTimeout(() => {
      bodyTimedOut = true;
      controller.abort();
    }, timeoutMs);

    if (!res.ok) {
      // ONLY a 401 (auth failure) clears the session. A 403 is authorization (CSRF/RBAC/permission) and
      // must surface as an error without signing the user out — see onUnauthorized's doc above.
      if (res.status === 401) onUnauthorized?.();
      let message = `Request failed (${res.status})`;
      let code: string | undefined;
      try {
        const parsed = (await res.json()) as {
          error?: { message?: string; code?: string } | string;
          code?: string;
        };
        const err = (parsed as { error?: unknown }).error;
        if (typeof err === "string") message = err;
        else if (err && typeof err === "object") {
          if (typeof (err as { message?: unknown }).message === "string") {
            message = (err as { message: string }).message;
          }
          if (typeof (err as { code?: unknown }).code === "string") {
            code = (err as { code: string }).code;
          }
        }
        // Prefer the standard error.code envelope emitted by the server's errorHandler; a top-level code is
        // a compatibility fallback for the handful of routes that still return one.
        if (!code && typeof parsed.code === "string") code = parsed.code;
      } catch {
        /* keep default message */
      }
      throw new ApiError(message, res.status, code);
    }

    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (e) {
      // Reading the body can fail for two unrelated reasons, and collapsing them loses the one thing
      // callers actually branch on.
      //
      // A SyntaxError means the body ARRIVED and is not JSON — a proxy's HTML error page, a route that
      // forgot to serialise, an empty 200. That is a real server response, so it keeps its real status.
      // Raw, it would escape as a SyntaxError rather than an ApiError, and every screen tests
      // `err instanceof ApiError` to decide what to show, so it fell through to a generic
      // "Something went wrong" with no status at all.
      if (e instanceof SyntaxError) {
        throw new ApiError(`Malformed response from the server (${res.status})`, res.status);
      }

      // Anything else is the CONNECTION dropping after the headers arrived but before the body finished.
      // Nothing is wrong with the server or its response — the network went away mid-read. Reporting that
      // as ApiError(status = 200) told every screen the request had succeeded and the payload was
      // malformed, so the offline checks (`status === 0`) missed it and a rep on a site with no signal was
      // shown a server-fault message for a connectivity problem.
      if (controller.signal.aborted) throw new ApiError("Request cancelled", 0);
      throw new ApiError(e instanceof Error ? e.message : "Network request failed", 0);
    }
  } finally {
    clearTimeout(bodyTimer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
