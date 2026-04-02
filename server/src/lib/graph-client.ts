const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

interface GraphClientOptions {
  accessToken: string;
}

interface GraphResponse<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

// Per-user circuit breaker state (prevents one bad mailbox from blocking all users)
interface CircuitBreakerState {
  consecutiveFailures: number;
  circuitOpenedAt: number | null;
}

const breakers = new Map<string, CircuitBreakerState>();
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_HALF_OPEN_MS = 60_000; // 60 seconds

function getBreaker(userId: string): CircuitBreakerState {
  let state = breakers.get(userId);
  if (!state) {
    state = { consecutiveFailures: 0, circuitOpenedAt: null };
    breakers.set(userId, state);
  }
  return state;
}

function isCircuitOpen(userId: string = "__global__"): boolean {
  const state = getBreaker(userId);
  if (state.consecutiveFailures < CIRCUIT_FAILURE_THRESHOLD) return false;
  if (state.circuitOpenedAt == null) return false;
  // Allow a single probe request after half-open interval
  if (Date.now() - state.circuitOpenedAt >= CIRCUIT_HALF_OPEN_MS) return false;
  return true;
}

function recordSuccess(userId: string = "__global__"): void {
  const state = getBreaker(userId);
  state.consecutiveFailures = 0;
  state.circuitOpenedAt = null;
}

function recordFailure(userId: string = "__global__"): void {
  const state = getBreaker(userId);
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && state.circuitOpenedAt == null) {
    state.circuitOpenedAt = Date.now();
    console.error(`[GraphClient] Circuit breaker OPEN for user ${userId} after ${state.consecutiveFailures} consecutive failures`);
  }
}

/**
 * Reset circuit breaker state. Pass userId to reset a specific user, or omit to clear all.
 */
export function resetCircuitBreaker(userId?: string): void {
  if (userId) {
    breakers.delete(userId);
  } else {
    breakers.clear();
  }
}

/**
 * Make an authenticated request to MS Graph API.
 * Retries up to 3 times with exponential backoff (1s, 3s, 9s).
 * Per-user circuit breaker opens after 5 consecutive failures for a given user.
 */
export async function graphRequest<T = any>(
  options: GraphClientOptions & {
    method?: string;
    path: string;
    body?: any;
    retries?: number;
    userId?: string; // Used for per-user circuit breaker keying
  }
): Promise<GraphResponse<T>> {
  const { accessToken, method = "GET", path, body, retries = 3, userId = "__global__" } = options;

  if (isCircuitOpen(userId)) {
    throw new Error(`MS Graph circuit breaker is OPEN for user ${userId} — requests blocked. Will retry after cooldown.`);
  }

  const url = path.startsWith("http") ? path : `${GRAPH_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      // 429 Too Many Requests — respect Retry-After header
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
        console.warn(`[GraphClient] Rate limited, waiting ${retryAfter}s (attempt ${attempt + 1}/${retries})`);
        await sleep(retryAfter * 1000);
        continue;
      }

      // 5xx server errors — retry
      if (res.status >= 500) {
        const backoffMs = Math.pow(3, attempt) * 1000; // 1s, 3s, 9s
        console.warn(`[GraphClient] Server error ${res.status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`);
        recordFailure(userId);
        await sleep(backoffMs);
        continue;
      }

      // 401 Unauthorized — token expired, do NOT retry (caller should refresh)
      if (res.status === 401) {
        recordSuccess(userId); // Not a server failure
        const data = await res.json().catch(() => ({}));
        return { ok: false, status: 401, data: data as T };
      }

      // All other responses (2xx, 4xx)
      recordSuccess(userId);
      const data = res.status === 204 ? ({} as T) : await res.json().catch(() => ({} as T));
      return { ok: res.ok, status: res.status, data: data as T };
    } catch (err: any) {
      lastError = err;
      recordFailure(userId);
      if (attempt < retries - 1) {
        const backoffMs = Math.pow(3, attempt) * 1000;
        console.warn(`[GraphClient] Network error, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries}): ${err.message}`);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError ?? new Error("MS Graph request failed after all retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
