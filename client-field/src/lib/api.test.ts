/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, resolveApiBase } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.sessionStorage.clear();
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

  it("sends credentialed JSON requests with requested-with and CSRF headers for unsafe methods", async () => {
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
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(headers.get("x-csrf-token")).toBe("csrf-123");
  });

  it("attaches requested-with to safe requests and preserves caller headers", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
    } as Response);

    await api<{ ok: boolean }>("/field/me", {
      headers: { "X-Correlation-Id": "trace-1" },
    });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(headers.get("X-Correlation-Id")).toBe("trace-1");
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
    await api("/field/projects");
    await api("/field/projects/starred");
    await api("/field/projects/deal-1/star", { method: "POST" });
    await api("/field/projects/deal-1/photos");
    await api("/field/photo-targets/search?search=roof");
    await api("/field/photo-targets/validate?dealId=deal-1");
    await api("/field/photos/upload-url", { method: "POST", json: { dealId: "deal-1", contentType: "image/jpeg", sizeBytes: 1024 } });
    await api("/field/photos/confirm-upload", { method: "POST", json: { dealId: "deal-1", uploadToken: "upload-token", objectKey: "photo.jpg" } });
    await api("/auth/invite-preview?token=raw-token");
    await api("/auth/accept-invite", { method: "POST", json: { token: "raw-token", password: "password-123" } });
    await api("/auth/field-login", { method: "POST", json: { email: "field@example.com", password: "password-123" } });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.example.com/api/field/me",
      "https://api.example.com/api/field/projects",
      "https://api.example.com/api/field/projects/starred",
      "https://api.example.com/api/field/projects/deal-1/star",
      "https://api.example.com/api/field/projects/deal-1/photos",
      "https://api.example.com/api/field/photo-targets/search?search=roof",
      "https://api.example.com/api/field/photo-targets/validate?dealId=deal-1",
      "https://api.example.com/api/field/photos/upload-url",
      "https://api.example.com/api/field/photos/confirm-upload",
      "https://api.example.com/api/auth/invite-preview?token=raw-token",
      "https://api.example.com/api/auth/accept-invite",
      "https://api.example.com/api/auth/field-login",
    ]);
    expect(fetchMock.mock.calls.every((call) => call[1]?.credentials === "include")).toBe(true);
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

  it("clears the stored office id when a field request returns 403", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com");
    window.sessionStorage.setItem("trock-field-active-office-id", "stale-office");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: { message: "No access to requested office" } }),
    } as Response);

    await expect(api("/field/me")).rejects.toMatchObject({
      status: 403,
      message: "No access to requested office",
    });

    expect(window.sessionStorage.getItem("trock-field-active-office-id")).toBeNull();
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
