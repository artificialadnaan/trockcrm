const RAILWAY_API_FALLBACK = "https://api-production-ad218.up.railway.app";
const FRONTEND_API_FALLBACK_HOSTS = new Set([
  "frontend-production-bcab.up.railway.app",
  "crm.trockconstruction.com",
]);

export function resolveApiBase(
  env: { VITE_API_URL?: string | undefined } = {},
  locationLike?: { hostname?: string | undefined }
): string {
  const configuredUrl = env.VITE_API_URL?.trim();
  if (configuredUrl) {
    return `${configuredUrl.replace(/\/+$/, "")}/api`;
  }

  const hostname = locationLike?.hostname?.trim().toLowerCase();
  if (hostname && FRONTEND_API_FALLBACK_HOSTS.has(hostname)) {
    return `${RAILWAY_API_FALLBACK}/api`;
  }

  return "/api";
}

const API_BASE = resolveApiBase((import.meta as any).env ?? {}, typeof window !== "undefined" ? window.location : undefined);

interface ApiOptions extends RequestInit {
  json?: Record<string, any>;
}

export async function api<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const { json, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (json) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(json);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers,
    credentials: "include",
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: "Request failed" } }));
    throw new Error(error.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}
