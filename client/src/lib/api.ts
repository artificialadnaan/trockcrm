const RAILWAY_API_FALLBACK = "https://api-production-ad218.up.railway.app";
const AI_COPILOT_API_FALLBACK = "https://api-ai-copilot.up.railway.app";
const FRONTEND_API_FALLBACK_HOSTS = new Set([
  "frontend-production-bcab.up.railway.app",
  "crm.trockconstruction.com",
]);
const AI_COPILOT_FRONTEND_FALLBACK_HOSTS = new Set([
  "frontend-ai-copilot.up.railway.app",
]);

export function resolveApiBase(
  env: { VITE_API_URL?: string | undefined } = {},
  locationLike?: { hostname?: string | undefined }
): string {
  const hostname = locationLike?.hostname?.trim().toLowerCase();
  if (hostname && AI_COPILOT_FRONTEND_FALLBACK_HOSTS.has(hostname)) {
    return `${AI_COPILOT_API_FALLBACK}/api`;
  }

  if (hostname && FRONTEND_API_FALLBACK_HOSTS.has(hostname)) {
    return `${RAILWAY_API_FALLBACK}/api`;
  }

  const configuredUrl = env.VITE_API_URL?.trim();
  if (configuredUrl) {
    return `${configuredUrl.replace(/\/+$/, "")}/api`;
  }

  return "/api";
}

const API_BASE = resolveApiBase((import.meta as any).env ?? {}, typeof window !== "undefined" ? window.location : undefined);
const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_HEADER_NAME = "X-CSRF-Token";
let csrfTokenOverride: string | undefined;

interface ApiOptions extends RequestInit {
  json?: Record<string, any>;
  /**
   * Skip auto-injecting the x-office-id header for this request, so the server evaluates it on the
   * user's HOME office (effective role == base role). Used for global resources fetched from a
   * global-admin page while a per-office override is selected (e.g. the office list on the Users tab),
   * where the office-scoped effective role would otherwise 403.
   */
  suppressOfficeHeader?: boolean;
  /**
   * Send the field-app CSRF header (`x-requested-with: XMLHttpRequest`) on this request. The global CSRF
   * middleware treats an unsafe `/api/field/*` request that carries a CRM auth cookie as a field-app request
   * and requires THIS header — the CRM double-submit header alone is rejected. Set for the token-scoped
   * corrective-action responder writes so a recipient who happens to also hold a CRM session can still
   * POST/upload (they could only READ otherwise). Session (non-token) field calls don't need it.
   */
  fieldCsrf?: boolean;
}

interface ApiErrorPayload {
  message?: string;
  code?: string;
  missingRequirements?: unknown;
  currentStage?: unknown;
  targetStage?: unknown;
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
}

export function getCsrfToken(): string | undefined {
  return readCookie(CSRF_COOKIE_NAME) ?? csrfTokenOverride;
}

export function clearCsrfTokenOverride() {
  csrfTokenOverride = undefined;
}

export function clearCsrfTokenOverrideForTests() {
  clearCsrfTokenOverride();
}

function readOfficeIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const officeId = new URLSearchParams(window.location.search).get("officeId")?.trim();
  return officeId || null;
}

function hasOfficeHeader(headers: Record<string, string>) {
  return Object.keys(headers).some((key) => key.toLowerCase() === "x-office-id");
}

/** Marker the auth middleware stamps on session-KILL 401s (deactivate / role-change / token-version). */
export const SESSION_INVALIDATED_CODE = "SESSION_INVALIDATED";

/**
 * The reliable, SSE-independent backstop for proactive logout: bounce to login ONLY on the specific
 * session-invalidation 401 — distinguished by the SESSION_INVALIDATED error code from the per-request
 * token_version + is_active recheck. NOT on permission 403s, ordinary/refreshable auth-token-expiry, or
 * any other 401 (those must not eject the user); and never while already on /login (no loop). Pure so
 * the over-redirect guard is unit-tested.
 */
export function shouldRedirectToLoginOnUnauthorized(args: { status: number; code: string | undefined; pathname: string }): boolean {
  if (args.status !== 401) return false;
  if (args.code !== SESSION_INVALIDATED_CODE) return false;
  return !args.pathname.startsWith("/login");
}

function isUnsafeMethod(method: string | undefined): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes((method ?? "GET").toUpperCase());
}

export class ApiError extends Error {
  status: number;
  code?: string;
  missingRequirements?: unknown;
  currentStage?: unknown;
  targetStage?: unknown;

  constructor(status: number, payload?: ApiErrorPayload) {
    super(payload?.message || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.code;
    this.missingRequirements = payload?.missingRequirements;
    this.currentStage = payload?.currentStage;
    this.targetStage = payload?.targetStage;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { json, suppressOfficeHeader, fieldCsrf, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };
  const officeId = readOfficeIdFromLocation();
  if (officeId && !suppressOfficeHeader && !hasOfficeHeader(headers)) {
    headers["x-office-id"] = officeId;
  }

  // Field-app CSRF header: required by the global middleware for an unsafe /api/field/* request that also
  // carries a CRM auth cookie (see ApiOptions.fieldCsrf). Harmless when no cookie is present.
  if (fieldCsrf) {
    headers["x-requested-with"] = "XMLHttpRequest";
  }

  if (json) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(json);
  }

  if (isUnsafeMethod(fetchOptions.method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers[CSRF_HEADER_NAME] = csrfToken;
    }
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers,
    credentials: "include",
  });

  async function parseJsonResponse() {
    if (res.status === 204) {
      return undefined as T;
    }

    const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      const body = await res.text().catch(() => "");
      const preview = body.slice(0, 120).replace(/\s+/g, " ").trim();
      throw new Error(
        `Expected JSON from ${path} but received ${contentType || "unknown content type"}${
          preview ? ` (${preview})` : ""
        }`
      );
    }

    return res.json();
  }

  function rememberCsrfToken(payload: unknown) {
    if (
      payload &&
      typeof payload === "object" &&
      "csrfToken" in payload &&
      typeof (payload as { csrfToken?: unknown }).csrfToken === "string"
    ) {
      const nextToken = (payload as { csrfToken: string }).csrfToken;
      if (readCookie(CSRF_COOKIE_NAME) === undefined) {
        csrfTokenOverride = nextToken;
      }
    }
  }

  if (!res.ok) {
    const error = await parseJsonResponse().catch(() => ({ error: { message: "Request failed" } }));
    if (
      typeof window !== "undefined" &&
      shouldRedirectToLoginOnUnauthorized({
        status: res.status,
        code: (error as { error?: { code?: string } })?.error?.code,
        pathname: window.location.pathname,
      })
    ) {
      window.location.assign("/login?reason=session-invalidated");
    }
    throw new ApiError(res.status, error.error);
  }

  const payload = await parseJsonResponse();
  rememberCsrfToken(payload);
  return payload;
}
