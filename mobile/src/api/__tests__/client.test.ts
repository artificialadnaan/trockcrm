import { apiFetch, ApiError } from "../client";

type MockFetch = (url: string, init: RequestInit) => Promise<unknown>;

describe("apiFetch", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function mockFetch(impl: MockFetch) {
    global.fetch = jest.fn(impl as unknown as typeof fetch);
  }

  it("appends /api, builds the query string, omits empty params, and sends Accept (GET has no CSRF header)", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    mockFetch(async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
    });

    const data = await apiFetch<{ ok: number }>("/field/projects", {
      query: { search: "a b", page: 2, skip: undefined },
    });

    expect(data).toEqual({ ok: 1 });
    expect(captured!.url).toContain("/api/field/projects?search=a%20b&page=2");
    expect(captured!.url).not.toContain("skip");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers["x-requested-with"]).toBeUndefined();
  });

  it("on unsafe methods sets x-requested-with + Content-Type + Authorization + x-office-id", async () => {
    let captured: { init: RequestInit } | null = null;
    mockFetch(async (_url, init) => {
      captured = { init };
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await apiFetch("/field/photos/upload-url", {
      method: "POST",
      body: { a: 1 },
      token: "jwt123",
      officeId: "off1",
    });

    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer jwt123");
    expect(headers["x-office-id"]).toBe("off1");
    expect(captured!.init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("invokes onUnauthorized and throws ApiError(401) with the server message", async () => {
    mockFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "nope" } }) }));
    const onUnauthorized = jest.fn();
    await expect(apiFetch("/field/me", { onUnauthorized })).rejects.toMatchObject({ status: 401, message: "nope" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke onUnauthorized on 403 (authorization, not auth) but still throws ApiError(403)", async () => {
    mockFetch(async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "forbidden" } }) }));
    const onUnauthorized = jest.fn();
    await expect(apiFetch("/field/projects/x/share", { method: "POST", body: {}, onUnauthorized }))
      .rejects.toMatchObject({ status: 403, message: "forbidden" });
    expect(onUnauthorized).not.toHaveBeenCalled(); // a 403 must never sign the user out
  });

  it("returns undefined for 204 No Content", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no body");
      },
    }));
    await expect(apiFetch("/field/photos/abc/tags/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("wraps transport failures as ApiError(0)", async () => {
    mockFetch(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(apiFetch("/field/me")).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch("/field/me")).rejects.toMatchObject({ status: 0 });
  });
});
