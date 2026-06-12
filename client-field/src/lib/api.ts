export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type ApiEnv = {
  VITE_API_BASE_URL?: string | undefined;
  VITE_API_URL?: string | undefined;
};

const FIELD_APP_OFFICE_STORAGE_KEY = "trock-field-active-office-id";
const FIELD_APP_CSRF_STORAGE_KEY = "trock-field-csrf-token";

export function clearStoredActiveOfficeId() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(FIELD_APP_OFFICE_STORAGE_KEY);
}

export function clearStoredCsrfToken() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(FIELD_APP_CSRF_STORAGE_KEY);
}

function storeCsrfToken(token: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(FIELD_APP_CSRF_STORAGE_KEY, token);
}

function storedCsrfToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.sessionStorage.getItem(FIELD_APP_CSRF_STORAGE_KEY)?.trim();
  return value || undefined;
}

export function resolveApiBase(env: ApiEnv): string {
  const configured = env.VITE_API_BASE_URL?.trim() || env.VITE_API_URL?.trim();
  if (!configured) {
    throw new Error("VITE_API_BASE_URL is required for the field app API client.");
  }
  return configured.replace(/\/+$/, "").replace(/\/api$/, "");
}

function configuredApiBase(): string {
  return resolveApiBase(import.meta.env as ApiEnv);
}

function activeOfficeId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("officeId")?.trim();
  if (fromQuery) {
    window.sessionStorage.setItem(FIELD_APP_OFFICE_STORAGE_KEY, fromQuery);
    return fromQuery;
  }
  const stored = window.sessionStorage.getItem(FIELD_APP_OFFICE_STORAGE_KEY)?.trim();
  return stored || undefined;
}

/**
 * The active office id the field app sends as `x-office-id` (URL `?officeId` → sessionStorage). This is
 * the office the single-office WRITE endpoints target, so the UI uses it (falling back to the user's
 * home office) to decide which cross-office projects are writable vs view-only.
 */
export function getActiveOfficeId(): string | undefined {
  return activeOfficeId();
}

function csrfToken(): string | undefined {
  const cookieToken = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("csrf_token="))
    ?.split("=")[1];
  return cookieToken || storedCsrfToken();
}

export async function api<T>(path: string, options: {
  method?: string;
  json?: unknown;
  body?: BodyInit | null;
  contentType?: string | false;
  signal?: AbortSignal;
  headers?: HeadersInit;
} = {}): Promise<T> {
  const method = options.method ?? (options.json === undefined ? "GET" : "POST");
  const headers = new Headers(options.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  const officeId = activeOfficeId();
  if (officeId) headers.set("x-office-id", officeId);
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
  } else if (options.contentType) {
    headers.set("Content-Type", options.contentType);
  }
  const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  const csrf = unsafe ? csrfToken() : undefined;
  if (csrf) headers.set("x-csrf-token", csrf);

  const response = await fetch(`${configuredApiBase()}/api${path}`, {
    method,
    headers,
    credentials: "include",
    signal: options.signal,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });

  async function parseJsonResponse() {
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      const body = await response.text().catch(() => "");
      const preview = body.slice(0, 120).replace(/\s+/g, " ").trim();
      throw new Error(
        `API returned non-JSON response. Check VITE_API_BASE_URL and CORS configuration.${
          preview ? ` Response started with: ${preview}` : ""
        }`
      );
    }
    const payload = await response.json() as T;
    const csrf = (payload as { csrfToken?: unknown } | null)?.csrfToken;
    if (typeof csrf === "string" && csrf.length > 0) {
      storeCsrfToken(csrf);
    }
    return payload;
  }

  if (!response.ok) {
    let message = "Request failed";
    try {
      const payload = await parseJsonResponse() as any;
      message = payload?.error?.message ?? payload?.error ?? message;
    } catch (err) {
      message = err instanceof Error ? err.message : message;
    }
    if (response.status === 401 || response.status === 403) {
      clearStoredActiveOfficeId();
      clearStoredCsrfToken();
    }
    throw new ApiError(message, response.status);
  }

  return parseJsonResponse();
}
