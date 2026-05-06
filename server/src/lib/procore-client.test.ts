import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../modules/procore/oauth-token-service.js", () => ({
  getStoredProcoreOauthTokens: vi.fn().mockResolvedValue(null),
  markProcoreOauthReauthNeeded: vi.fn(),
  refreshStoredProcoreOauthTokens: vi.fn(),
}));

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean; headers?: Record<string, string> } = {}) {
  return {
    ok: init.ok ?? ((init.status ?? 200) >= 200 && (init.status ?? 200) < 300),
    status: init.status ?? 200,
    headers: { get: (key: string) => init.headers?.[key] ?? null },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

async function importClient() {
  vi.resetModules();
  process.env.PROCORE_CLIENT_ID = "client-id";
  process.env.PROCORE_CLIENT_SECRET = "client-secret";
  process.env.PROCORE_COMPANY_ID = "company-123";
  return import("./procore-client.js");
}

describe("procore client PR 140 API surface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.PROCORE_CLIENT_ID;
    delete process.env.PROCORE_CLIENT_SECRET;
    delete process.env.PROCORE_COMPANY_ID;
  });

  it("creates image categories with the expected endpoint, payload, auth token, and company header", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: 55, name: "T Rock Photos" }));

    const result = await procoreClient.request<{ id: number }>("/rest/v1.0/image_categories?project_id=123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_category: { name: "T Rock Photos", private: false } }),
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toEqual({ id: 55, name: "T Rock Photos" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://api.procore.com/rest/v1.0/image_categories?project_id=123", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Procore-Company-Id": "company-123",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ image_category: { name: "T Rock Photos", private: false } }),
    }));
  });

  it.each([
    [403, "forbidden"],
    [500, "server exploded"],
  ])("surfaces Procore request errors for status %s", async (status, body) => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(body, { status, ok: false }));

    await expect(procoreClient.request("/rest/v1.0/image_categories?project_id=123", {
      method: "POST",
      body: "{}",
      fetchImpl: fetchMock as typeof fetch,
    })).rejects.toThrow(`[Procore] POST /rest/v1.0/image_categories?project_id=123 failed: ${status}`);
  });

  it("surfaces network failures while uploading photos", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockRejectedValueOnce(new Error("network down"));
    const form = new FormData();
    form.append("image[image_category_id]", "55");
    form.append("image[data]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "photo.jpg");

    await expect(procoreClient.request("/rest/v1.0/images?project_id=123", {
      method: "POST",
      body: form,
      fetchImpl: fetchMock as typeof fetch,
    })).rejects.toThrow("network down");
  });

  it("uploads photos through multipart form data and parses the returned Procore photo id", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: 98765 }));
    const form = new FormData();
    form.append("image[image_category_id]", "55");
    form.append("image[data]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "photo.jpg");

    const result = await procoreClient.request<{ id: number }>("/rest/v1.0/images?project_id=123", {
      method: "POST",
      body: form,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.id).toBe(98765);
    const uploadCall = fetchMock.mock.calls[1];
    expect(uploadCall[0]).toBe("https://api.procore.com/rest/v1.0/images?project_id=123");
    expect(uploadCall[1]).toEqual(expect.objectContaining({ method: "POST", body: form }));
    expect(uploadCall[1].headers).toEqual(expect.objectContaining({ "Procore-Company-Id": "company-123" }));
  });

  it("calls the v2 project links bulk_update endpoint and parses the link id", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 444, title: "T Rock Photos" }]));

    const result = await procoreClient.request<Array<{ id: number }>>("/rest/v2.0/companies/company-123/projects/123/links/bulk_update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ title: "T Rock Photos", url: "https://crm.test/p/raw" }]),
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result[0].id).toBe(444);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://api.procore.com/rest/v2.0/companies/company-123/projects/123/links/bulk_update", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "Procore-Company-Id": "company-123", "Content-Type": "application/json" }),
      body: JSON.stringify([{ title: "T Rock Photos", url: "https://crm.test/p/raw" }]),
    }));
  });

  it("reuses cached auth tokens until the refresh buffer is reached", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "cached-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await procoreClient.request("/rest/v1.0/image_categories?project_id=123", { method: "GET", fetchImpl: fetchMock as typeof fetch });
    await procoreClient.request("/rest/v1.0/image_categories?project_id=123", { method: "GET", fetchImpl: fetchMock as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.procore.com/oauth/token");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer cached-token");
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer cached-token");
  });

  it("maps company project pages from Procore rows with string and object addresses", async () => {
    const { listCompanyProjectsPage } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 1,
          name: "Name One",
          display_name: "Display One",
          project_number: "P-1",
          city: "Dallas",
          state_code: "TX",
          address: "100 Main St",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          name: "Name Two",
          displayName: "Display Two",
          projectNumber: "P-2",
          address: { street: "200 Oak St", city: "Austin", stateCode: "TX" },
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ]));

    const rows = await listCompanyProjectsPage("company-123", 2, 25, { fetchImpl: fetchMock as typeof fetch });

    expect(rows).toEqual([
      {
        id: 1,
        name: "Name One",
        displayName: "Display One",
        projectNumber: "P-1",
        city: "Dallas",
        state: "TX",
        address: "100 Main St",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 2,
        name: "Name Two",
        displayName: "Display Two",
        projectNumber: "P-2",
        city: "Austin",
        state: "TX",
        address: "200 Oak St",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.procore.com/rest/v1.0/companies/company-123/projects?page=2&per_page=25");
  });

  it("maps company project candidates and falls back to Project id naming", async () => {
    const { listCompanyProjectCandidatesPage } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 9, address: null, city: null, state_code: null, updated_at: null } ]));

    const rows = await listCompanyProjectCandidatesPage("company-123", 1, 10, { fetchImpl: fetchMock as typeof fetch });

    expect(rows).toEqual([{ id: 9, name: "Project 9", projectNumber: null, city: null, state: null, address: null, updatedAt: null }]);
  });

  it("lists Procore users and requires a company id", async () => {
    const { listProcoreUsers } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 7, name: "Admin" }]));

    process.env.PROCORE_COMPANY_ID = "company-123";
    vi.stubGlobal("fetch", fetchMock);
    const users = await listProcoreUsers();

    expect(users).toEqual([{ id: 7, name: "Admin" }]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.procore.com/rest/v1.0/companies/company-123/users");

    vi.unstubAllGlobals();
    delete process.env.PROCORE_COMPANY_ID;
    expect(() => listProcoreUsers()).toThrow("PROCORE_COMPANY_ID is required");
  });

  it("uses stored OAuth tokens for GET requests and refreshes expiring tokens", async () => {
    const oauth = await import("../modules/procore/oauth-token-service.js");
    vi.mocked(oauth.getStoredProcoreOauthTokens)
      .mockResolvedValueOnce({
        status: "active",
        accessToken: "stored-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 3_600_000),
      } as any)
      .mockResolvedValueOnce({
        status: "active",
        accessToken: "old-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 1_000),
      } as any);
    vi.mocked(oauth.refreshStoredProcoreOauthTokens).mockResolvedValueOnce("refreshed-token");
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await procoreClient.get("/rest/v1.0/projects/1", { fetchImpl: fetchMock as typeof fetch });
    await procoreClient.get("/rest/v1.0/projects/1", { fetchImpl: fetchMock as typeof fetch });

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer stored-token");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer refreshed-token");
    expect(oauth.refreshStoredProcoreOauthTokens).toHaveBeenCalledWith("refresh-token", expect.objectContaining({ fetchImpl: fetchMock }));
  });

  it("marks OAuth reauth needed when an OAuth GET receives 401 or 403", async () => {
    const oauth = await import("../modules/procore/oauth-token-service.js");
    vi.mocked(oauth.getStoredProcoreOauthTokens).mockResolvedValueOnce({
      status: "active",
      accessToken: "stored-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
    } as any);
    const { procoreClient, isProcoreOauthRequiredError } = await importClient();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse("unauthorized", { status: 401, ok: false }));

    await expect(procoreClient.get("/rest/v1.0/projects/1", { fetchImpl: fetchMock as typeof fetch })).rejects.toThrow("PROCORE_OAUTH_REQUIRED");
    expect(isProcoreOauthRequiredError(new Error("PROCORE_OAUTH_REQUIRED"))).toBe(true);
    expect(oauth.markProcoreOauthReauthNeeded).toHaveBeenCalledWith(undefined, "oauth read failed: 401");
  });

  it("rejects inactive stored OAuth tokens before making a request", async () => {
    const oauth = await import("../modules/procore/oauth-token-service.js");
    vi.mocked(oauth.getStoredProcoreOauthTokens).mockResolvedValueOnce({ status: "reauth_required" } as any);
    const { procoreClient, isProcoreOauthRequiredError, isProcoreOauthRefreshError } = await importClient();
    const fetchMock = vi.fn();

    await expect(procoreClient.get("/rest/v1.0/projects/1", { fetchImpl: fetchMock as typeof fetch })).rejects.toThrow("PROCORE_OAUTH_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isProcoreOauthRequiredError(new Error("PROCORE_OAUTH_REQUIRED"))).toBe(true);
    expect(isProcoreOauthRefreshError(new Error("PROCORE_OAUTH_REFRESH_FAILED"))).toBe(true);
  });

  it("returns empty objects for 204 responses and parseJson=false requests", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse("", { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ ignored: true }));

    await expect(procoreClient.request("/rest/v1.0/projects/1", { method: "DELETE", fetchImpl: fetchMock as typeof fetch })).resolves.toEqual({});
    await expect(procoreClient.request("/rest/v1.0/projects/1", { method: "GET", parseJson: false, fetchImpl: fetchMock as typeof fetch })).resolves.toEqual({});
  });


  it("uses dev-mode mock responses when Procore credentials are absent", async () => {
    vi.resetModules();
    delete process.env.PROCORE_CLIENT_ID;
    delete process.env.PROCORE_CLIENT_SECRET;
    const { procoreClient } = await import("./procore-client.js");

    expect(procoreClient.isDevMode()).toBe(true);
    await expect(procoreClient.get("/rest/v1.0/companies/1/projects?page=1")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: "Mock Project" })]));
    await expect(procoreClient.post("/rest/v1.0/companies/1/projects", {})).resolves.toEqual(expect.objectContaining({ active: true }));
    await expect(procoreClient.patch("/rest/v1.0/projects/1", {})).resolves.toEqual(expect.objectContaining({ stage: "Updated" }));
    await expect(procoreClient.get("/rest/v1.0/change_orders")).resolves.toEqual([]);
    await expect(procoreClient.get("/rest/v1.0/projects/1")).resolves.toEqual(expect.objectContaining({ stage: "Active" }));
  });

  it("fails clearly when client-credentials token fetch fails", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse("bad credentials", { status: 401, ok: false }));

    await expect(procoreClient.request("/rest/v1.0/projects/1", { method: "GET", fetchImpl: fetchMock as typeof fetch })).rejects.toThrow("Token fetch failed: 401 bad credentials");
  });

  it("retries transient JSON request failures and records a closed circuit after success", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse("temporary", { status: 500, ok: false }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = procoreClient.post("/rest/v1.0/projects", { project: { name: "P" } });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(resultPromise).resolves.toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(procoreClient.getCircuitState()).toMatchObject({ state: "closed", failures: 0, openedAt: null });
  });

  it("honors Retry-After for 429 responses before succeeding", async () => {
    const { procoreClient } = await importClient();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse("rate limited", { status: 429, ok: false, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = procoreClient.patch("/rest/v1.0/projects/1", { project: { stage: "Active" } });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(resultPromise).resolves.toEqual({ id: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

});
