/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(document, "cookie", { value: "", writable: true });
});

describe("field api client", () => {
  it("sends credentialed JSON requests with CSRF headers for unsafe methods", async () => {
    Object.defineProperty(document, "cookie", { value: "csrf_token=csrf-123", writable: true });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    const result = await api<{ ok: boolean }>("/auth/field-login", {
      method: "POST",
      json: { email: "field@example.com" },
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/field-login", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ email: "field@example.com" }),
    }));
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("csrf-123");
  });

  it("throws ApiError with server messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "CRM access required" } }),
    } as Response);

    await expect(api("/deals")).rejects.toMatchObject({
      status: 403,
      message: "CRM access required",
    });
  });
});
