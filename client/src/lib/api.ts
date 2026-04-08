export function resolveApiBase(env: { VITE_API_URL?: string | undefined } = {}): string {
  const configuredUrl = env.VITE_API_URL?.trim();
  if (!configuredUrl) return "/api";

  return `${configuredUrl.replace(/\/+$/, "")}/api`;
}

const API_BASE = resolveApiBase((import.meta as any).env ?? {});

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
