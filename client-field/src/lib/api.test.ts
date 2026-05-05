/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, resolveApiBase } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(document, "cookie", { value: "", writable: true });
});

describe("field api client", () => {
  it("resolves the configured API base URL and handles trailing slashes", () => {
    expect(resolveApiBase({ VITE_API_BASE_URL: "https://api.example.com/" }))
      .toBe("https://api.example.com");
    expect(resolveApiBase({ VITE_API_BASE_URL: "https://api.example.com/api" }))
      .toBe("https://api.example.com");
    expect(resolveApiBase({ VITE_API_URL: "https://legacy-api.example.com/" }))
      .toBe("https://legacy-api.example.com");
  });

  it("throws a clear configuration error when the API base URL is missing", () => {
    expect(() => resolveApiBase({})).toThrow("VITE_API_BASE_URL is required");
  });

  it("sends credentialed JSON requests with CSRF headers for unsafe methods", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/");
    Object.defineProperty(document, "cookie", { value: "csrf_token=csrf-123", writable: true });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
    } as Response);

    const result = await api<{ ok: boolean }>("/auth/field-login", {
      method: "POST",
      json: { email: "field@example.com" },
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/api/auth/field-login", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ email: "field@example.com" }),
    }));
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("csrf-123");
  });

  it("routes all current field app endpoints through the configured API service", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({}),
    } as Response);

    await api("/field/me");
    await api("/auth/invite-preview?token=raw-token");
    await api("/auth/accept-invite", { method: "POST", json: { token: "raw-token", password: "password-123" } });
    await api("/auth/field-login", { method: "POST", json: { email: "field@example.com", password: "password-123" } });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.example.com/api/field/me",
      "https://api.example.com/api/auth/invite-preview?token=raw-token",
      "https://api.example.com/api/auth/accept-invite",
      "https://api.example.com/api/auth/field-login",
    ]);
  });

  it("throws ApiError with server messages", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: { message: "CRM access required" } }),
    } as Response);

    await expect(api("/deals")).rejects.toMatchObject({
      status: 403,
      message: "CRM access required",
    });
  });

  it("throws a diagnostic error when the API returns a non-JSON response", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => "<!doctype html><html><body>Field app shell</body></html>",
    } as Response);

    await expect(api("/auth/invite-preview?token=raw-token")).rejects.toThrow(
      "API returned non-JSON response. Check VITE_API_BASE_URL and CORS configuration."
    );
  });
});
