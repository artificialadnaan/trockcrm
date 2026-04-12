// server/src/lib/procore-client.ts
// Procore API client with OAuth client credentials, retry, and circuit breaker.

import {
  getStoredProcoreOauthTokens,
  markProcoreOauthReauthNeeded,
  refreshStoredProcoreOauthTokens,
} from "../modules/procore/oauth-token-service.js";

const PROCORE_BASE_URL = "https://api.procore.com";
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 3000, 9000];
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 60_000;
const OAUTH_REFRESH_BUFFER_MS = 60_000;

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

let cachedClientCredentialsToken: { value: string; expiresAt: number } | null = null;

/**
 * Dev mode: when PROCORE_CLIENT_ID is not set, all API calls return mock data.
 */
function isDevMode(): boolean {
  return !process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET;
}

async function getAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (isDevMode()) {
    return "dev-mock-token";
  }

  if (
    cachedClientCredentialsToken &&
    cachedClientCredentialsToken.expiresAt - Date.now() > OAUTH_REFRESH_BUFFER_MS
  ) {
    return cachedClientCredentialsToken.value;
  }

  const clientId = process.env.PROCORE_CLIENT_ID!;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET!;

  const res = await fetchImpl(`${PROCORE_BASE_URL}/oauth/token`, {
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
  cachedClientCredentialsToken = {
    value: data.access_token,
    // data.expires_in is in seconds; subtract 60s buffer
    expiresAt: Date.now() + (data.expires_in * 1000) - OAUTH_REFRESH_BUFFER_MS,
  };
  return cachedClientCredentialsToken.value;
}

type StoredProcoreOauthTokens = Awaited<ReturnType<typeof getStoredProcoreOauthTokens>>;

interface ProcoreReadAuthOptions {
  fetchImpl?: typeof fetch;
  getStoredTokens?: () => Promise<StoredProcoreOauthTokens>;
  refreshStoredTokens?: (refreshToken: string, options?: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) => Promise<string>;
  markOauthReauthNeeded?: (errorMessage: string) => Promise<void>;
  now?: () => Date;
  companyId?: string;
}

function isProcoreOauthRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message === "PROCORE_OAUTH_REQUIRED";
}

async function resolveProcoreReadAuth(options: ProcoreReadAuthOptions = {}) {
  const getStoredTokens = options.getStoredTokens ?? getStoredProcoreOauthTokens;
  const refreshStoredTokens = options.refreshStoredTokens ?? refreshStoredProcoreOauthTokens;
  const now = options.now ?? (() => new Date());
  const stored = await getStoredTokens();

  if (stored) {
    if (stored.status !== "active") {
      throw new Error("PROCORE_OAUTH_REQUIRED");
    }

    const expiresInMs = stored.expiresAt.getTime() - now().getTime();
    const accessToken =
      expiresInMs <= OAUTH_REFRESH_BUFFER_MS
        ? await refreshStoredTokens(stored.refreshToken, {
            fetchImpl: options.fetchImpl,
            now,
          })
        : stored.accessToken;

    return {
      mode: "oauth" as const,
      accessToken,
      companyHeader: process.env.PROCORE_COMPANY_ID ?? options.companyId ?? "",
    };
  }

  if (isDevMode()) {
    return {
      mode: "dev" as const,
      accessToken: "dev-mock-token",
      companyHeader: null,
    };
  }

  return {
    mode: "client_credentials" as const,
    accessToken: await getAccessToken(options.fetchImpl),
    companyHeader: process.env.PROCORE_COMPANY_ID ?? options.companyId ?? "",
  };
}

let mockIdCounter = 100000;

function getMockResponse(method: string, path: string): any {
  if (method === "GET" && path.includes("/projects?")) {
    return [
      {
        id: 1,
        name: "Mock Project",
        display_name: "Mock Project",
        project_number: "MOCK-1",
        city: "Dallas",
        state_code: "TX",
        address: "100 Mock St",
        updated_at: new Date().toISOString(),
      },
    ];
  }
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
  body?: unknown,
  options: ProcoreReadAuthOptions = {}
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const markOauthReauthNeeded =
    options.markOauthReauthNeeded ?? ((errorMessage: string) => markProcoreOauthReauthNeeded(undefined, errorMessage));
  checkCircuit();

  const auth =
    method === "GET"
      ? await resolveProcoreReadAuth(options)
      : isDevMode()
        ? {
            mode: "dev" as const,
            accessToken: "dev-mock-token",
            companyHeader: null,
          }
        : {
            mode: "client_credentials" as const,
            accessToken: await getAccessToken(fetchImpl),
            companyHeader: null,
          };

  if (auth.mode === "dev") {
    console.log(`[Procore:dev] Mock ${method} ${path}`);
    return getMockResponse(method, path) as T;
  }
  const url = `${PROCORE_BASE_URL}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(method === "GET" && auth.mode === "oauth" && auth.companyHeader
            ? { "Procore-Company-Id": auth.companyHeader }
            : {}),
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

      if (method === "GET" && auth.mode === "oauth" && (res.status === 401 || res.status === 403)) {
        await markOauthReauthNeeded(`oauth read failed: ${res.status}`);
        throw new Error("PROCORE_OAUTH_REQUIRED");
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`[Procore] ${method} ${path} failed: ${res.status} ${errBody}`);
      }

      const data: T = res.status === 204 ? ({} as T) : await res.json();
      recordSuccess();
      return data;
    } catch (err) {
      if (isProcoreOauthRequiredError(err)) {
        throw err;
      }
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
  get: <T = any>(path: string, options?: ProcoreReadAuthOptions) =>
    procoreFetch<T>("GET", path, undefined, options),
  post: <T = any>(path: string, body: unknown) => procoreFetch<T>("POST", path, body),
  patch: <T = any>(path: string, body: unknown) => procoreFetch<T>("PATCH", path, body),
  delete: <T = any>(path: string) => procoreFetch<T>("DELETE", path),
  /** Expose circuit breaker state for admin status endpoint */
  getCircuitState: () => ({ ...breaker }),
  /** Check if running in dev/mock mode */
  isDevMode,
};

export interface ProcoreCompanyProjectRow {
  id: number;
  name?: string | null;
  display_name?: string | null;
  project_number?: string | null;
  city?: string | null;
  state_code?: string | null;
  address?: string | null;
  updated_at?: string | null;
}

export async function listCompanyProjectsPage(
  companyId: string,
  page: number,
  pageSize: number,
  options: ProcoreReadAuthOptions = {}
): Promise<
  Array<{
    id: number;
    name: string | null;
    displayName: string | null;
    projectNumber: string | null;
    city: string | null;
    state: string | null;
    address: string | null;
    updatedAt: string | null;
  }>
> {
  const rows = await procoreClient.get<ProcoreCompanyProjectRow[]>(
    `/rest/v1.0/companies/${companyId}/projects?page=${page}&per_page=${pageSize}`,
    {
      ...options,
      companyId,
    }
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? null,
    displayName: row.display_name ?? null,
    projectNumber: row.project_number ?? null,
    city: row.city ?? null,
    state: row.state_code ?? null,
    address: row.address ?? null,
    updatedAt: row.updated_at ?? null,
  }));
}

export interface ProcoreProjectCandidateRow {
  id: number;
  name: string;
  projectNumber: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  updatedAt: string | null;
}

export async function listCompanyProjectCandidatesPage(
  companyId: string,
  page: number,
  pageSize: number,
  options: ProcoreReadAuthOptions = {}
): Promise<ProcoreProjectCandidateRow[]> {
  const rows = await listCompanyProjectsPage(companyId, page, pageSize, options);

  return rows.map((row) => ({
    id: row.id,
    name: row.displayName || row.name || `Project ${row.id}`,
    projectNumber: row.projectNumber,
    city: row.city,
    state: row.state,
    address: row.address,
    updatedAt: row.updatedAt,
  }));
}
