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

describe("envelope unwrapping", () => {
  // Every one of these was returned as the RAW envelope in the first version of this file. The stages
  // one crashed the deals list outright (for..of over an object); the detail one rendered every field
  // undefined; the activity one made the note feature 400 on every submission.
  it("GET /deals/stages unwraps { stages } — iterating the envelope throws", async () => {
    const { fetcher } = recording({ stages: [{ id: "s1", name: "Bidding" }] });
    await expect(deals.listStages(fetcher)).resolves.toHaveLength(1);
  });

  it("GET /deals/:id/detail unwraps { deal }", async () => {
    const { fetcher } = recording({ deal: { id: "d1", name: "Roof replacement" } });
    await expect(deals.getDealDetail(fetcher, "d1")).resolves.toMatchObject({ name: "Roof replacement" });
  });

  it("POST /activities sends `type` and `body`, the fields the server actually reads", async () => {
    // The server 400s when `type` is absent. Sending activityType/notes broke every note submission —
    // the headline interaction of the app — with a request that looked perfectly well-formed.
    const { fetcher, calls } = recording({ activity: { id: "a1" } });
    await deals.createActivity(fetcher, { dealId: "d1", type: "note", body: "Met the super on site" });
    const sent = calls[0].opts.body as Record<string, unknown>;
    expect(sent.type).toBe("note");
    expect(sent.body).toBe("Met the super on site");
    expect(sent).not.toHaveProperty("activityType");
    expect(sent).not.toHaveProperty("notes");
  });

  it("POST /activities unwraps { activity }", async () => {
    const { fetcher } = recording({ activity: { id: "a1", type: "note" } });
    await expect(
      deals.createActivity(fetcher, { dealId: "d1", type: "note", body: "x" }),
    ).resolves.toMatchObject({ id: "a1" });
  });
});

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
    // The server requires `targetStageId` and 400s without it.
    expect(calls[0].opts.body).toEqual({ targetStageId: "stage-2" });
  });

  it("commits to a different path than preflight", async () => {
    // Getting these two confused would either silently no-op or move a stage the rep only meant to check.
    const { fetcher, calls } = recording({});
    await deals.moveStage(fetcher, "d1", { targetStageId: "stage-2" });
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

  it("unwraps { activities }", async () => {
    const { fetcher } = recording({ activities: [{ id: "a1" }, { id: "a2" }] });
    await expect(deals.listActivities(fetcher, "d1")).resolves.toHaveLength(2);
  });
});

describe("displayAmount — the canonical value priority", () => {
  const empty = {
    awardedAmount: null,
    bidEstimate: null,
    ddEstimate: null,
    bidBoardTotalSales: null,
    stageSlug: null,
    workflowRoute: null,
  };

  it("prefers an awarded amount once one exists", () => {
    expect(displayAmount({ ...empty, awardedAmount: "250000.00", bidEstimate: "100000.00" })).toBe("$250,000");
  });

  it("uses bidBoardTotalSales ahead of the bid estimate", () => {
    // Considering only awarded and bid — as the first version did — showed a LOWER number on every Bid
    // Board deal. Wrong money on a sales tool is worse than none.
    expect(displayAmount({ ...empty, bidBoardTotalSales: "180000.00", bidEstimate: "90000.00" })).toBe("$180,000");
  });

  it("falls back to the DD estimate last on a normal stage", () => {
    expect(displayAmount({ ...empty, ddEstimate: "70000.00" })).toBe("$70,000");
  });

  it("promotes DD above bid on the estimating stage", () => {
    // Stage-aware override: awarded > dd > bid_board > bid while genuinely estimating.
    expect(
      displayAmount({ ...empty, stageSlug: "estimating", ddEstimate: "120000.00", bidEstimate: "90000.00" }),
    ).toBe("$120,000");
  });

  it("does not apply the estimating override on the service route", () => {
    expect(
      displayAmount({
        ...empty,
        stageSlug: "estimating",
        workflowRoute: "service",
        ddEstimate: "120000.00",
        bidEstimate: "90000.00",
      }),
    ).toBe("$90,000");
  });

  it("treats a stored zero as no value, not as $0", () => {
    expect(displayAmount({ ...empty, awardedAmount: "0.00", bidEstimate: "50000.00" })).toBe("$50,000");
  });

  it("shows an em dash only when there is genuinely nothing", () => {
    expect(displayAmount(empty)).toBe("—");
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
