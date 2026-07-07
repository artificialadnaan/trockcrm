import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  getRfpEstimators,
  resetRfpEstimatorsCacheForTests,
  sanitizeRfpEstimators,
  type RfpEstimator,
} from "../src/modules/deals/rfp-estimators-service.js";

const SECRET = "test-synchub-secret";
const ENV = { SYNCHUB_SHARED_SECRET: SECRET, SYNCHUB_BASE_URL: "https://synchub.example" } as NodeJS.ProcessEnv;

function okResponse(estimators: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ estimators }) } as unknown as Response;
}

// Faithful stand-in for the real buildOfficeRosterFallback, which sanitizes (trims + lowercases) its output.
function roster(...names: Array<[string, string]>): (officeId?: string | null) => Promise<RfpEstimator[]> {
  return async () => sanitizeRfpEstimators(names.map(([name, email]) => ({ name, email })));
}

beforeEach(() => {
  resetRfpEstimatorsCacheForTests();
});

describe("sanitizeRfpEstimators", () => {
  it("trims names, trims + lowercases emails, drops empties, and dedupes by email", () => {
    expect(
      sanitizeRfpEstimators([
        { name: "  Colby Burling  ", email: "CBurling@TROCKGC.com" },
        { name: "Colby B", email: "cburling@trockgc.com" }, // dup email → dropped
        { name: "", email: "" }, // empty → dropped
        { name: "Tim Mitchell", email: " tmitchell@trockgc.com " },
      ])
    ).toEqual([
      { name: "Colby Burling", email: "cburling@trockgc.com" },
      { name: "Tim Mitchell", email: "tmitchell@trockgc.com" },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeRfpEstimators(null)).toEqual([]);
    expect(sanitizeRfpEstimators(undefined)).toEqual([]);
    expect(sanitizeRfpEstimators("nope" as unknown)).toEqual([]);
  });
});

describe("getRfpEstimators — SyncHub path", () => {
  it("fetches SyncHub with the empty-body HMAC signature over the estimators URL and sanitizes the result", async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ name: " Colby Burling ", email: "CBurling@TROCKGC.com" }]));

    const result = await getRfpEstimators({
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
      loadRoster: roster(["Should Not Be Used", "x@x.com"]),
    });

    expect(result.source).toBe("synchub");
    expect(result.estimators).toEqual([{ name: "Colby Burling", email: "cburling@trockgc.com" }]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://synchub.example/api/rfp/estimators");
    expect((init as RequestInit).method).toBe("GET");
    const expectedSig = `sha256=${crypto.createHmac("sha256", SECRET).update("").digest("hex")}`;
    expect((init as RequestInit).headers).toMatchObject({ "x-rfp-request-signature": expectedSig });
  });

  it("serves the cached SyncHub result within the 5-min TTL without re-fetching", async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ name: "Colby", email: "c@x.com" }]));

    const first = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });
    const second = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 + 4 * 60 * 1000 });

    expect(first.source).toBe("synchub");
    expect(second.source).toBe("synchub-cache");
    expect(second.estimators).toEqual([{ name: "Colby", email: "c@x.com" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches SyncHub after the TTL expires", async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ name: "Colby", email: "c@x.com" }]));

    await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });
    const later = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 + 5 * 60 * 1000 + 1 });

    expect(later.source).toBe("synchub");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("getRfpEstimators — fallback path", () => {
  it("falls back to the office roster when SyncHub errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await getRfpEstimators({
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
      loadRoster: roster(["Roster Rep", "RR@Office.com"]),
    });

    expect(result.source).toBe("roster-fallback");
    expect(result.estimators).toEqual([{ name: "Roster Rep", email: "rr@office.com" }]);
  });

  it("falls back when SyncHub returns a non-2xx status", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);

    const result = await getRfpEstimators({
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
      loadRoster: roster(["Roster Rep", "rr@office.com"]),
    });

    expect(result.source).toBe("roster-fallback");
    expect(result.estimators).toEqual([{ name: "Roster Rep", email: "rr@office.com" }]);
  });

  it("falls back to the roster when SyncHub returns 2xx but the wrong shape (no estimators field)", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ data: [{ name: "X", email: "x@x.com" }] }) }) as unknown as Response
    );

    const result = await getRfpEstimators({
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
      loadRoster: roster(["Roster Rep", "rr@office.com"]),
    });

    expect(result.source).toBe("roster-fallback");
    expect(result.estimators).toEqual([{ name: "Roster Rep", email: "rr@office.com" }]);
  });

  it("does NOT cache an empty SyncHub list — an explicit [] falls through to the roster", async () => {
    const fetchImpl = vi.fn(async () => okResponse([]));

    const first = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000, loadRoster: roster(["Roster Rep", "rr@office.com"]) });
    // Within what would have been the TTL: still roster (nothing empty got cached).
    const second = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 + 60_000, loadRoster: roster(["Roster Rep", "rr@office.com"]) });

    expect(first.source).toBe("roster-fallback");
    expect(second.source).toBe("roster-fallback");
    expect(second.estimators).toEqual([{ name: "Roster Rep", email: "rr@office.com" }]);
  });

  it("negative-caches a failure for 30s (skips SyncHub) then retries after the window", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("down");
      })
      .mockImplementationOnce(async () => okResponse([{ name: "Recovered", email: "r@x.com" }]));

    // t=1000 → SyncHub throws, negative cache set until 31_000
    const first = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000, loadRoster: roster(["Roster", "ro@x.com"]) });
    // t=5000 → within negative window: SyncHub NOT retried, straight to roster
    const during = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 5_000, loadRoster: roster(["Roster", "ro@x.com"]) });
    // t=32000 → past window: SyncHub retried, now succeeds
    const after = await getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 32_000, loadRoster: roster(["Roster", "ro@x.com"]) });

    expect(first.source).toBe("roster-fallback");
    expect(during.source).toBe("roster-fallback");
    expect(after.source).toBe("synchub");
    expect(after.estimators).toEqual([{ name: "Recovered", email: "r@x.com" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // NOT 3 — the during-window call skipped SyncHub
  });

  it("falls back when the shared secret is not configured (no fetch attempted)", async () => {
    const fetchImpl = vi.fn(async () => okResponse([]));

    const result = await getRfpEstimators({
      env: {} as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
      loadRoster: roster(["Roster Rep", "rr@office.com"]),
    });

    expect(result.source).toBe("roster-fallback");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("getRfpEstimators — concurrency", () => {
  it("collapses concurrent cold-miss requests into a single SyncHub fetch (no thundering herd)", async () => {
    let releaseFetch!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = vi.fn(() => gate);

    // Both start before the shared fetch settles → they must share one in-flight request.
    const p1 = getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });
    const p2 = getRfpEstimators({ env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });

    releaseFetch(okResponse([{ name: "Colby", email: "c@x.com" }]));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.source).toBe("synchub");
    expect(r2.source).toBe("synchub");
    expect(r1.estimators).toEqual([{ name: "Colby", email: "c@x.com" }]);
    expect(r2.estimators).toEqual([{ name: "Colby", email: "c@x.com" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // shared in-flight promise, not one fetch per caller
  });
});
