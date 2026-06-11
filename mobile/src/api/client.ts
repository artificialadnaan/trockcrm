import { API_BASE_URL } from "../config";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export type ApiFetchOptions = {
  /** Bearer JWT (from the field session). */
  token?: string | null;
  /** Active office id → sent as `x-office-id` (tenant routing). */
  officeId?: string | null;
  method?: string;
  /** JSON-serializable request body. */
  body?: unknown;
  query?: QueryParams;
  /** Called on 401/403 so the caller can clear the session. */
  onUnauthorized?: () => void;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function buildQuery(query?: QueryParams): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * The single JSON HTTP client for the field API.
 *
 * Replicates client-field/src/lib/api.ts for native:
 *  - `Authorization: Bearer <jwt>` (no cookie jar — RN has no durable cookie store)
 *  - `x-requested-with: XMLHttpRequest` on every unsafe method — THIS is the field
 *    CSRF gate (server: FIELD_CSRF_HEADER_NAME). Omitting it → 403 on all writes.
 *  - `x-office-id` for multi-office tenant routing.
 *
 * Raw-binary endpoints (R2 PUT, audio transcription) do NOT go through here — they
 * use expo-file-system uploadAsync (see capture/upload.ts, dictation/transcribe.ts).
 */
export async function apiFetch<T = unknown>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const {
    token,
    officeId,
    method = "GET",
    body,
    query,
    onUnauthorized,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = opts;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (officeId) headers["x-office-id"] = officeId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE_METHODS.has(method.toUpperCase())) headers["x-requested-with"] = "XMLHttpRequest";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api${path}${buildQuery(query)}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) throw new ApiError("Request timed out", 408);
    // Wrap transport-level failures (offline, DNS, refused) as ApiError(0) so
    // callers only ever handle one error type.
    throw new ApiError(e instanceof Error ? e.message : "Network request failed", 0);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) onUnauthorized?.();
    let message = `Request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { error?: { message?: string } | string };
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === "string") message = err;
      else if (err && typeof (err as { message?: string }).message === "string") {
        message = (err as { message: string }).message;
      }
    } catch {
      /* keep default message */
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
