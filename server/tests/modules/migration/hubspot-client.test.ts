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
});
