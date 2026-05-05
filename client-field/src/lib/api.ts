export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function configuredApiBase(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const configured = env.VITE_API_BASE_URL ?? env.VITE_API_URL;
  if (configured) return configured.replace(/\/+$/, "").replace(/\/api$/, "");
  return "";
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

  if (!response.ok) {
    let message = "Request failed";
    try {
      const payload = await response.json();
      message = payload?.error?.message ?? payload?.error ?? message;
    } catch {
      // Keep the generic message when the API does not return JSON.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
