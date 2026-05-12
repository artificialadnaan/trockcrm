/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, clearCsrfTokenOverrideForTests, resolveApiBase } from "./api";

describe("resolveApiBase", () => {
  it("uses the same-origin api path by default", () => {
    expect(resolveApiBase({})).toBe("/api");
  });

  it("uses the configured VITE_API_URL when provided", () => {
    expect(resolveApiBase({ VITE_API_URL: "https://api-production-ad218.up.railway.app" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
  });

  it("removes a trailing slash from VITE_API_URL", () => {
    expect(resolveApiBase({ VITE_API_URL: "https://api-production-ad218.up.railway.app/" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
  });

  it("uses the Railway API fallback on the deployed frontend hosts", () => {
    expect(resolveApiBase({}, { hostname: "frontend-production-bcab.up.railway.app" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
    expect(resolveApiBase({}, { hostname: "crm.trockconstruction.com" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
  });

  it("uses the ai-copilot API fallback on the ai-copilot frontend host", () => {
    expect(resolveApiBase({}, { hostname: "frontend-ai-copilot.up.railway.app" }))
      .toBe("https://api-ai-copilot.up.railway.app/api");
  });
});

describe("api CSRF handling", () => {
  const tempSecret = "TempPassword123!";
  const nextSecret = "NewPassword123!";

  beforeEach(() => {
    clearCsrfTokenOverrideForTests();
    document.cookie = "csrf_token=; Max-Age=0; path=/";
    vi.restoreAllMocks();
  });

  it("reuses a trusted response-body csrf token when the cookie is not readable by the frontend origin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "server-issued-token", user: { id: "user-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await api("/auth/local/login", {
      method: "POST",
      json: { email: "rep@example.com", password: tempSecret },
    });
    await api("/auth/local/change-password", {
      method: "POST",
      json: { currentPassword: tempSecret, newPassword: nextSecret },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-CSRF-Token": "server-issued-token",
        }),
      })
    );
  });

  it("prefers the trusted response-body token over a stale readable cookie", async () => {
    document.cookie = "csrf_token=stale-cookie-token; path=/";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "fresh-response-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await api("/auth/me");
    await api("/auth/local/change-password", {
      method: "POST",
      json: { currentPassword: tempSecret, newPassword: nextSecret },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-CSRF-Token": "fresh-response-token",
        }),
      })
    );
  });
});
