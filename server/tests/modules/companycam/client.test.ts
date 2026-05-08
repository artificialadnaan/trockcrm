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

describe("CompanyCam client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.COMPANYCAM_API_KEY = "companycam-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.COMPANYCAM_API_KEY;
  });

  it("aborts hung CompanyCam requests with a clean timeout error", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const { getProject } = await import("../../../src/modules/companycam/client.js");

    const resultPromise = getProject("project-1");
    const expectation = expect(resultPromise).rejects.toThrow("CompanyCam /projects/project-1 timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
  });
});
