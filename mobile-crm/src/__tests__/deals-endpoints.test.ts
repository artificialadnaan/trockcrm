import * as deals from "../api/endpoints/deals";
import type { Fetcher } from "../api/endpoints/auth";
import { displayAmount, showsAtRisk } from "../components/DealCard";
import type { AtRiskResult } from "../api/types";

function recording(result: unknown = {}) {
  const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
  const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
    calls.push({ path, opts });
    return result;
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

describe("listDeals", () => {
  it("uses the LIST endpoint, never the per-row detail read", async () => {
    // tenant.deals has ~153 columns and /detail additionally resolves company/contact joins. Building a
    // list from it would be brutal on a phone and on the API.
    const { fetcher, calls } = recording({ deals: [], pagination: {} });
    await deals.listDeals(fetcher);
    expect(calls[0].path).toBe("/deals");
  });

  it("omits an empty or whitespace-only search rather than sending it", async () => {
    const { fetcher, calls } = recording({ deals: [], pagination: {} });
    await deals.listDeals(fetcher, { search: "   " });
    expect((calls[0].opts.query as Record<string, unknown>).search).toBeUndefined();
  });

  it("drops page 0, which the query builder would otherwise transmit", async () => {
    // apiFetch's buildQuery strips undefined/null/"" but KEEPS 0 — and page=0 is not a valid page.
    const { fetcher, calls } = recording({ deals: [], pagination: {} });
    await deals.listDeals(fetcher, { page: 0 });
    expect((calls[0].opts.query as Record<string, unknown>).page).toBeUndefined();
  });

  it("passes a real page through", async () => {
    const { fetcher, calls } = recording({ deals: [], pagination: {} });
    await deals.listDeals(fetcher, { page: 2, scope: "watched" });
    const query = calls[0].opts.query as Record<string, unknown>;
    expect(query.page).toBe(2);
    expect(query.scope).toBe("watched");
  });
});

describe("stage move", () => {
  it("preflights against the target stage without committing", async () => {
    const { fetcher, calls } = recording({ allowed: true });
    await deals.preflightStage(fetcher, "d1", "stage-2");
    expect(calls[0].path).toBe("/deals/d1/stage/preflight");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.body).toEqual({ stageId: "stage-2" });
  });

  it("commits to a different path than preflight", async () => {
    // Getting these two confused would either silently no-op or move a stage the rep only meant to check.
    const { fetcher, calls } = recording({});
    await deals.moveStage(fetcher, "d1", { stageId: "stage-2" });
    expect(calls[0].path).toBe("/deals/d1/stage");
  });
});

describe("watch toggle", () => {
  it.each([
    ["watchDeal", "POST"],
    ["unwatchDeal", "DELETE"],
  ])("%s uses %s on the same path", async (fn, method) => {
    const { fetcher, calls } = recording({});
    await (deals as unknown as Record<string, (f: Fetcher, id: string) => Promise<unknown>>)[fn](
      fetcher,
      "d1",
    );
    expect(calls[0].path).toBe("/deals/d1/watch");
    expect(calls[0].opts.method).toBe(method);
  });
});

describe("listActivities", () => {
  it("scopes to the deal", async () => {
    const { fetcher, calls } = recording([]);
    await deals.listActivities(fetcher, "d1");
    expect(calls[0].path).toBe("/activities");
    expect((calls[0].opts.query as Record<string, unknown>).dealId).toBe("d1");
  });

  it.each([
    ["a bare array", [{ id: "a1" }], 1],
    ["an { activities } envelope", { activities: [{ id: "a1" }, { id: "a2" }] }, 2],
    ["neither", {}, 0],
  ])("tolerates %s", async (_case, payload, expected) => {
    // The auth routes proved this codebase is not uniform about envelopes, and guessing wrong here
    // renders an EMPTY timeline rather than throwing — the silent kind of wrong.
    const { fetcher } = recording(payload);
    await expect(deals.listActivities(fetcher, "d1")).resolves.toHaveLength(expected);
  });
});

describe("displayAmount", () => {
  it("prefers an awarded amount once one exists", () => {
    expect(displayAmount({ awardedAmount: "250000.00", bidEstimate: "100000.00" })).toBe("$250,000");
  });

  it("falls back to the bid estimate before the deal is won", () => {
    // Showing "—" on a deal that has an estimate reads as "no value", which is a different claim.
    expect(displayAmount({ awardedAmount: null, bidEstimate: "100000.00" })).toBe("$100,000");
  });

  it("shows an em dash only when there is genuinely nothing", () => {
    expect(displayAmount({ awardedAmount: null, bidEstimate: null })).toBe("—");
  });
});

describe("showsAtRisk", () => {
  const base: AtRiskResult = {
    isAtRisk: true,
    status: "at_risk",
    severity: "high",
    effectiveStageAgeDays: 40,
    thresholdDays: 30,
  };

  it("shows the badge only on a full server verdict", () => {
    expect(showsAtRisk({ atRisk: base })).toBe(true);
  });

  it.each([
    ["the flag is false", { ...base, isAtRisk: false }],
    ["severity is none", { ...base, severity: "none" }],
    ["status is not at_risk", { ...base, status: "postponed" }],
    ["there is no verdict", null],
  ])("hides it when %s", (_case, atRisk) => {
    // The flag alone is not sufficient — severity and status both participate. Recomputing the rule on
    // device would drift from the web app, which has changed it repeatedly.
    expect(showsAtRisk({ atRisk: atRisk as AtRiskResult | null })).toBe(false);
  });
});
