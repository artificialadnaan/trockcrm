// server/src/lib/procore-client.ts
// Procore API client with OAuth client credentials, retry, and circuit breaker.

const PROCORE_BASE_URL = "https://api.procore.com";
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 3000, 9000];
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

type CircuitState = "closed" | "open" | "half_open";

interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

const breaker: CircuitBreaker = {
  state: "closed",
  failures: 0,
  openedAt: null,
};

function checkCircuit(): void {
  if (breaker.state === "open") {
    const elapsed = Date.now() - (breaker.openedAt ?? 0);
    if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
      breaker.state = "half_open";
      console.warn("[Procore] Circuit breaker half-open — probing");
    } else {
      throw new Error("[Procore] Circuit breaker is OPEN — refusing request");
    }
  }
}

function recordSuccess(): void {
  breaker.failures = 0;
  breaker.state = "closed";
  breaker.openedAt = null;
}

function recordFailure(): void {
  breaker.failures += 1;
  if (breaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    breaker.state = "open";
    breaker.openedAt = Date.now();
    console.error(
      `[Procore] Circuit breaker OPEN after ${breaker.failures} consecutive failures`
    );
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Dev mode: when PROCORE_CLIENT_ID is not set, all API calls return mock data.
 */
function isDevMode(): boolean {
  return !process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET;
}

async function getAccessToken(): Promise<string> {
  if (isDevMode()) {
    return "dev-mock-token";
  }

  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.value;
  }

  const clientId = process.env.PROCORE_CLIENT_ID!;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET!;

  const res = await fetch(`${PROCORE_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[Procore] Token fetch failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    // data.expires_in is in seconds; subtract 60s buffer
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

let mockIdCounter = 100000;

function getMockResponse(method: string, path: string): any {
  if (method === "POST" && path.includes("/projects")) {
    return { id: ++mockIdCounter, name: "Mock Project", active: true };
  }
  if (method === "PATCH" && path.includes("/projects")) {
    return { id: 1, name: "Mock Project", stage: "Updated" };
  }
  if (method === "GET" && path.includes("/change_orders")) {
    return [];
  }
  if (method === "GET" && path.includes("/projects/")) {
    return { id: 1, name: "Mock Project", stage: "Active", updated_at: new Date().toISOString() };
  }
  return {};
}

async function procoreFetch<T = any>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  if (isDevMode()) {
    console.log(`[Procore:dev] Mock ${method} ${path}`);
    return getMockResponse(method, path) as T;
  }

  checkCircuit();

  const token = await getAccessToken();
  const url = `${PROCORE_BASE_URL}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
        if (attempt < MAX_RETRIES) {
          console.warn(
            `[Procore] 429 rate limited — waiting ${retryAfter}s (attempt ${attempt + 1}/${MAX_RETRIES})`
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw new Error(`[Procore] Rate limited (429) after ${MAX_RETRIES} retries`);
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`[Procore] ${method} ${path} failed: ${res.status} ${errBody}`);
      }

      const data: T = res.status === 204 ? ({} as T) : await res.json();
      recordSuccess();
      return data;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_MS[attempt] ?? 9000;
        console.warn(
          `[Procore] Request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`,
          err
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      recordFailure();
      throw err;
    }
  }

  // TypeScript requires an explicit return — unreachable
  throw new Error("[Procore] Unexpected exit from retry loop");
}

export const procoreClient = {
  get: <T = any>(path: string) => procoreFetch<T>("GET", path),
  post: <T = any>(path: string, body: unknown) => procoreFetch<T>("POST", path, body),
  patch: <T = any>(path: string, body: unknown) => procoreFetch<T>("PATCH", path, body),
  delete: <T = any>(path: string) => procoreFetch<T>("DELETE", path),
  /** Expose circuit breaker state for admin status endpoint */
  getCircuitState: () => ({ ...breaker }),
  /** Check if running in dev/mock mode */
  isDevMode,
};
