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

function csrfToken(): string | undefined {
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("csrf_token="))
    ?.split("=")[1];
}

export async function api<T>(path: string, options: {
  method?: string;
  json?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const method = options.method ?? (options.json === undefined ? "GET" : "POST");
  const headers = new Headers();
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  const csrf = unsafe ? csrfToken() : undefined;
  if (csrf) headers.set("x-csrf-token", csrf);

  const response = await fetch(`${configuredApiBase()}/api${path}`, {
    method,
    headers,
    credentials: "include",
    signal: options.signal,
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
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
    return response.json() as Promise<T>;
  }

  if (!response.ok) {
    let message = "Request failed";
    try {
      const payload = await parseJsonResponse() as any;
      message = payload?.error?.message ?? payload?.error ?? message;
    } catch (err) {
      message = err instanceof Error ? err.message : message;
    }
    throw new ApiError(message, response.status);
  }

  return parseJsonResponse();
}
