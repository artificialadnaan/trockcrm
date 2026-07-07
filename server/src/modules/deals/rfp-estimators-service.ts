import { resolveSyncHubEstimatorsUrl, signSyncHubRequestBody } from "./rfp-payload.js";
import { listUsers } from "../admin/users-service.js";
import { isCrmUserRole } from "../../middleware/field-auth.js";

export interface RfpEstimator {
  name: string;
  email: string;
}

export type RfpEstimatorSource = "synchub" | "synchub-cache" | "roster-fallback";

export interface RfpEstimatorsResult {
  estimators: RfpEstimator[];
  source: RfpEstimatorSource;
}

// SyncHub's estimator list is a single global config (not office-scoped), so a successful
// fetch is cached process-wide for 5 minutes. On failure we skip SyncHub for 30 seconds
// (negative cache) to avoid hammering it on every vote-form load, and serve the active
// office's CRM roster in the meantime.
const SYNCHUB_TTL_MS = 5 * 60 * 1000;
const SYNCHUB_FAIL_TTL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

interface CacheState {
  estimators: RfpEstimator[] | null;
  expiresAt: number;
  failUntil: number;
  // Shared in-flight SyncHub fetch so a burst of concurrent cold-miss vote-form loads
  // collapses into ONE upstream request instead of a thundering herd.
  inFlight: Promise<RfpEstimator[]> | null;
}

const cache: CacheState = { estimators: null, expiresAt: 0, failUntil: 0, inFlight: null };

/** Test-only: clear the module-level SyncHub cache + negative-cache window. */
export function resetRfpEstimatorsCacheForTests(): void {
  cache.estimators = null;
  cache.expiresAt = 0;
  cache.failUntil = 0;
  cache.inFlight = null;
}

/** Trim names, trim + lowercase emails, drop fully-empty rows, dedupe by email (else name). */
export function sanitizeRfpEstimators(list: unknown): RfpEstimator[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: RfpEstimator[] = [];
  for (const raw of list) {
    const name = String((raw as { name?: unknown } | null)?.name ?? "").trim();
    const email = String((raw as { email?: unknown } | null)?.email ?? "")
      .trim()
      .toLowerCase();
    if (!name && !email) continue;
    const key = email || name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, email });
  }
  return out;
}

async function fetchSyncHubEstimators(opts: {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<RfpEstimator[]> {
  const { env, fetchImpl, timeoutMs } = opts;
  const secret = env.SYNCHUB_SHARED_SECRET;
  if (!secret) throw new Error("SYNCHUB_SHARED_SECRET is not configured");

  const url = resolveSyncHubEstimatorsUrl(env);
  // A GET has no body; sign the empty string so SyncHub's verifyRfpRequestSignature(req, Buffer.from(""))
  // computes the same HMAC. Only a caller holding the shared secret can produce this signature.
  const signature = signSyncHubRequestBody("", secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "x-rfp-request-signature": signature },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`SyncHub estimators responded ${res.status}`);
    const body = (await res.json()) as { estimators?: unknown };
    const estimators = sanitizeRfpEstimators(body?.estimators);
    // Treat an empty result as a miss and THROW: a 2xx with the wrong shape (e.g. {data:[…]})
    // or a genuinely empty list would otherwise cache [] for the full TTL and hide the roster
    // fallback. Throwing routes to the office roster (a usable suggestion list) + the 30s
    // negative cache, so we retry SyncHub shortly instead of serving nothing.
    if (estimators.length === 0) throw new Error("SyncHub returned no usable estimators");
    return estimators;
  } finally {
    clearTimeout(timer);
  }
}

/** Active office's CRM roster mapped to {name,email} — the offline fallback for the suggestion list. */
async function buildOfficeRosterFallback(officeId?: string | null): Promise<RfpEstimator[]> {
  const rows = (await listUsers(officeId ?? undefined)) as Array<{
    email: string;
    displayName: string;
    role?: string;
    isActive: boolean;
  }>;
  return sanitizeRfpEstimators(
    rows
      .filter((u) => u.isActive && (typeof u.role === "string" ? isCrmUserRole(u.role) : true))
      .map((u) => ({ name: u.displayName, email: u.email }))
  );
}

export async function getRfpEstimators(opts: {
  officeId?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  loadRoster?: (officeId?: string | null) => Promise<RfpEstimator[]>;
} = {}): Promise<RfpEstimatorsResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const loadRoster = opts.loadRoster ?? buildOfficeRosterFallback;
  const at = now();

  if (cache.estimators && at < cache.expiresAt) {
    return { estimators: cache.estimators, source: "synchub-cache" };
  }

  if (at >= cache.failUntil) {
    // Share one upstream fetch across concurrent cold-miss callers (no thundering herd).
    const fetchPromise = cache.inFlight ?? (cache.inFlight = fetchSyncHubEstimators({ env, fetchImpl, timeoutMs }));
    try {
      const estimators = await fetchPromise;
      cache.estimators = estimators;
      cache.expiresAt = at + SYNCHUB_TTL_MS;
      cache.failUntil = 0;
      return { estimators, source: "synchub" };
    } catch (err) {
      cache.failUntil = at + SYNCHUB_FAIL_TTL_MS;
      console.warn(
        "[rfp-estimators] SyncHub fetch failed, serving office roster fallback:",
        err instanceof Error ? err.message : err
      );
    } finally {
      // Clear only our own in-flight promise (a newer request may have installed its own).
      if (cache.inFlight === fetchPromise) cache.inFlight = null;
    }
  }

  const estimators = await loadRoster(opts.officeId);
  return { estimators, source: "roster-fallback" };
}
