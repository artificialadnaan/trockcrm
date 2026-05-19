import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function hangingFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })
  );
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean; headers?: Record<string, string> } = {}) {
  return {
    ok: init.ok ?? ((init.status ?? 200) >= 200 && (init.status ?? 200) < 300),
    status: init.status ?? 200,
    headers: { get: (key: string) => init.headers?.[key] ?? null },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("HubSpot migration client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.HUBSPOT_PRIVATE_APP_TOKEN = "hubspot-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  });

  it("aborts hung HubSpot requests with a clean timeout error", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const { fetchAllDeals } = await import("../../../src/modules/migration/hubspot-client.js");

    const resultPromise = fetchAllDeals();
    const expectation = expect(resultPromise).rejects.toThrow(/HubSpot .*timed out after 30000ms/);
    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
  });

  it("honors Retry-After for 429 responses before retrying", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("rate limited", { status: 429, ok: false, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ results: [], paging: undefined }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAllDeals } = await import("../../../src/modules/migration/hubspot-client.js");

    const resultPromise = fetchAllDeals();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(resultPromise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx responses with exponential backoff", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("server error", { status: 500, ok: false }))
      .mockResolvedValueOnce(jsonResponse({ results: [], paging: undefined }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAllDeals } = await import("../../../src/modules/migration/hubspot-client.js");

    const resultPromise = fetchAllDeals();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-rate-limit 4xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse("bad request", { status: 400, ok: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAllDeals } = await import("../../../src/modules/migration/hubspot-client.js");

    await expect(fetchAllDeals()).rejects.toThrow("HubSpot API error: 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly when the retry budget is exhausted", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("server error 1", { status: 503, ok: false }))
      .mockResolvedValueOnce(jsonResponse("server error 2", { status: 502, ok: false }))
      .mockResolvedValueOnce(jsonResponse("server error 3", { status: 500, ok: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAllDeals } = await import("../../../src/modules/migration/hubspot-client.js");

    const resultPromise = fetchAllDeals();
    const expectation = expect(resultPromise).rejects.toThrow("HubSpot API error: 500");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("paginates HubSpot owners across multiple pages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "owner-1", email: "one@example.com" }],
          paging: { next: { after: "cursor-2" } },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "owner-2", email: "two@example.com" }],
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAllOwners } = await import("../../../src/modules/migration/hubspot-client.js");

    await expect(fetchAllOwners()).resolves.toEqual([
      { id: "owner-1", email: "one@example.com" },
      { id: "owner-2", email: "two@example.com" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requests the full property set for note backfills", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ results: [], paging: undefined }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchHubSpotActivitiesByType } = await import("../../../src/modules/migration/hubspot-client.js");

    await expect(fetchHubSpotActivitiesByType("note")).resolves.toEqual([]);

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("/crm/v3/objects/notes?");
    expect(requestUrl).toContain("associations=deals%2Ccompanies%2Ccontacts");
    expect(requestUrl).toContain("properties=");
    expect(requestUrl).toContain("hs_note_body");
    expect(requestUrl).toContain("hs_attachment_ids");
    expect(requestUrl).toContain("createdate");
  });

  it("requests the full property set for call, meeting, and email backfills", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [], paging: undefined }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchHubSpotActivitiesByType } = await import("../../../src/modules/migration/hubspot-client.js");

    await expect(fetchHubSpotActivitiesByType("call")).resolves.toEqual([]);
    await expect(fetchHubSpotActivitiesByType("meeting")).resolves.toEqual([]);
    await expect(fetchHubSpotActivitiesByType("email")).resolves.toEqual([]);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const callUrl = urls.find((url) => url.includes("/crm/v3/objects/calls?")) ?? "";
    const meetingUrl = urls.find((url) => url.includes("/crm/v3/objects/meetings?")) ?? "";
    const emailUrl = urls.find((url) => url.includes("/crm/v3/objects/emails?")) ?? "";

    expect(callUrl).toContain("hs_call_body");
    expect(callUrl).toContain("hs_call_title");
    expect(callUrl).toContain("hs_call_direction");
    expect(callUrl).toContain("hs_call_disposition");
    expect(callUrl).toContain("hs_attachment_ids");
    expect(meetingUrl).toContain("hs_meeting_body");
    expect(meetingUrl).toContain("hs_meeting_title");
    expect(meetingUrl).toContain("hs_meeting_start_time");
    expect(meetingUrl).toContain("hs_meeting_end_time");
    expect(meetingUrl).toContain("hs_attachment_ids");
    expect(emailUrl).toContain("hs_email_subject");
    expect(emailUrl).toContain("hs_email_text");
    expect(emailUrl).toContain("hs_email_html");
    expect(emailUrl).toContain("hs_email_headers");
    expect(emailUrl).toContain("hs_attachment_ids");
    expect(emailUrl).toContain("createdate");
  });
});
