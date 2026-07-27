import * as pipeline from "../api/endpoints/pipeline";
import type { Fetcher } from "../api/endpoints/auth";

function recording(result: unknown = {}) {
  const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
  const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
    calls.push({ path, opts });
    return result;
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

/**
 * The pipeline contracts, pinned against the SERVER rather than against the OpenAPI spec or the web
 * client — both of which describe this endpoint incorrectly.
 */
describe("GET /deals/pipeline", () => {
  it("reads cards from column.deals, NOT column.cards", async () => {
    // The web client calls them `cards`, but that is a client-side rename in normalizeDealBoardResponse.
    // The wire field is `deals`. Copying the web type yields an empty board on a perfectly good response.
    const { fetcher } = recording({
      pipelineColumns: [
        { stage: { id: "s1", name: "Opportunity", slug: "opportunity" }, deals: [{ id: "d1" }], totalValue: 1, activeCount: 1, totalCount: 1, count: 1 },
      ],
      terminalStages: [],
    });
    const res = await pipeline.getPipeline(fetcher, { scope: "mine" });
    expect(res.pipelineColumns[0].deals).toHaveLength(1);
  });

  it("does not expect the object-keyed-by-stage-id shape the OpenAPI spec documents", async () => {
    // api-spec.ts describes this as "keys are stage IDs, values are arrays of deals". It is not, and a
    // client written from the spec renders nothing while the request succeeds.
    const { fetcher } = recording({ pipelineColumns: [], terminalStages: [] });
    const res = await pipeline.getPipeline(fetcher, { scope: "mine" });
    expect(Array.isArray(res.pipelineColumns)).toBe(true);
  });

  it("ALWAYS sends an explicit scope", async () => {
    // normalizeCollaborativeScope is `requested ?? "mine"` with no validation: omitting scope is merely
    // owner-scoped, but an unrecognised value falls through every branch and returns an UNSCOPED,
    // office-wide board. Never leaving it to a default is the only safe habit.
    const { fetcher, calls } = recording({ pipelineColumns: [], terminalStages: [] });
    await pipeline.getPipeline(fetcher, { scope: "watched" });
    expect((calls[0].opts.query as Record<string, unknown>).scope).toBe("watched");
  });

  it("caps cards per column instead of taking the server default", async () => {
    // The default is 100 per column across ~10 columns, each the full ~120-column deals row — multiple
    // megabytes on cellular for a board that shows a handful of cards at a time.
    const { fetcher, calls } = recording({ pipelineColumns: [], terminalStages: [] });
    await pipeline.getPipeline(fetcher, { scope: "mine" });
    // The EXACT value, not a range. A bound of "<= 25 and > 0" passes for 1 as happily as for 15, so it
    // would not notice the cap being changed to something that guts the board or bloats the payload.
    expect((calls[0].opts.query as Record<string, number>).previewLimit).toBe(15);
  });

  it("asks for ALL-TIME Won and Lost, in the spelling the route reads", async () => {
    // Without these the server windows both terminal columns to the last 30 days and says nothing about
    // it, so the board reports a month's Won total as if it were the whole thing. snake_case because the
    // route tests `req.query.won_all_time === "true"` and ignores camelCase.
    const { fetcher, calls } = recording({ pipelineColumns: [], terminalStages: [] });
    await pipeline.getPipeline(fetcher, { scope: "mine" });
    const query = calls[0].opts.query as Record<string, string>;
    expect(query.won_all_time).toBe("true");
    expect(query.lost_all_time).toBe("true");
  });

  it("degrades to empty arrays rather than undefined", async () => {
    const { fetcher } = recording({});
    const res = await pipeline.getPipeline(fetcher, { scope: "mine" });
    expect(res).toEqual({ pipelineColumns: [], terminalStages: [] });
  });
});

describe("stage move contracts", () => {
  it("preflights with targetStageId, the name the server requires", async () => {
    const { fetcher, calls } = recording({ allowed: true });
    await pipeline.preflightStage(fetcher, "d1", "s2");
    expect(calls[0].opts.body).toEqual({ targetStageId: "s2" });
  });

  it("commits to a different path than preflight", async () => {
    const { fetcher, calls } = recording({ deal: { id: "d1" } });
    await pipeline.moveStage(fetcher, "d1", { targetStageId: "s2" });
    expect(calls[0].path).toBe("/deals/d1/stage");
  });

  it("unwraps { deal } from the commit response", async () => {
    const { fetcher } = recording({ deal: { id: "d1" }, stageHistory: [], eventsEmitted: [] });
    await expect(pipeline.moveStage(fetcher, "d1", { targetStageId: "s2" })).resolves.toEqual({
      deal: { id: "d1" },
    });
  });

  it("reads lost reasons from the /pipeline mount, not /deals", async () => {
    const { fetcher, calls } = recording({ reasons: [{ id: "r1", label: "Price", displayOrder: 1 }] });
    await expect(pipeline.listLostReasons(fetcher)).resolves.toHaveLength(1);
    expect(calls[0].path).toBe("/pipeline/lost-reasons");
  });
});

describe("canMoveStage", () => {
  /**
   * THE trap. The commit route calls assertDealOwnerRouteAccess with neither allowAdmin nor
   * allowDirector, so a non-owner gets a flat 403 — an admin included. Preflight has no ownership check
   * at all, so it will happily return allowed:true to someone who cannot commit.
   */
  it("allows only the assigned rep", () => {
    expect(pipeline.canMoveStage({ assignedRepId: "u1" }, "u1")).toBe(true);
  });

  it("refuses a non-owner even though preflight would say allowed", () => {
    expect(pipeline.canMoveStage({ assignedRepId: "someone-else" }, "u1")).toBe(false);
  });

  it.each([null, undefined])("refuses an unassigned deal (%p)", (assigned) => {
    expect(pipeline.canMoveStage({ assignedRepId: assigned }, "u1")).toBe(false);
  });

  it("refuses when the field is ABSENT rather than matching undefined to undefined", () => {
    // The plain /deals list row has no assignedRepId. `undefined === undefined` would be true and would
    // offer the action to everyone on that shape.
    expect(pipeline.canMoveStage({}, undefined)).toBe(false);
  });
});

describe("lost-stage detection", () => {
  /**
   * Exercised against the PRODUCTION set (pipeline.isLostOutcomeStageSlug), not a copy.
   *
   * The previous version of this block declared its own `LOST` array and then asserted things like
   * `expect(LOST.includes(slug)).toBe(true)` — a literal compared with itself. It could not fail, and it
   * proved it: it went on listing `deal_canceled` as a Lost slug for two commits after the shipping set
   * had dropped it, which is the exact drift a mirror test exists to catch.
   *
   * The server requires a reason id AND non-blank notes for these. A screen that does not recognise the
   * target as Lost collects neither, and the rep gets a rejection naming fields they were never shown.
   */
  it.each(["lost", "production_lost", "service_lost", "closed_lost"])(
    "treats %s as a Lost move",
    (slug) => {
      expect(pipeline.isLostOutcomeStageSlug(slug)).toBe(true);
    },
  );

  it("includes the CANONICAL slug, not just the legacy aliases", () => {
    // The first mirror had all four aliases and omitted this one — the slug current pipelines actually
    // use — so it failed on the common case and worked on the legacy ones.
    expect(pipeline.isLostOutcomeStageSlug("lost")).toBe(true);
  });

  it("excludes deal_canceled, which the stage-change route does NOT accept as a Lost outcome", () => {
    // It IS lost for REPORTING (shared LOST_DEAL_STAGE_SLUGS) and is not a Lost outcome for this
    // REQUEST. Prompting on it collected a reason and notes the server then discarded.
    expect(pipeline.isLostOutcomeStageSlug("deal_canceled")).toBe(false);
  });

  it.each(["won", "closed_won", "estimating", "opportunity", "contract"])(
    "does not treat %s as Lost",
    (slug) => {
      expect(pipeline.isLostOutcomeStageSlug(slug)).toBe(false);
    },
  );

  it("is safe on a missing slug rather than throwing inside a render", () => {
    expect(pipeline.isLostOutcomeStageSlug(null)).toBe(false);
    expect(pipeline.isLostOutcomeStageSlug(undefined)).toBe(false);
  });
});

describe("stageMoveLock", () => {
  it("locks a change order — nobody may move one, whatever preflight says", () => {
    const lock = pipeline.stageMoveLock({ isChangeOrder: true });
    expect(lock.locked).toBe(true);
  });

  it("does not lock an ordinary deal", () => {
    expect(pipeline.stageMoveLock({ isChangeOrder: false }).locked).toBe(false);
    expect(pipeline.stageMoveLock({ isChangeOrder: null }).locked).toBe(false);
    expect(pipeline.stageMoveLock({}).locked).toBe(false);
  });

  /**
   * The lock is about the DEAL, ownership is about the USER, and they are independent: the assigned rep
   * of a change order is still refused. Gating one on the other would let the owner through to a 409.
   */
  it("is independent of ownership", () => {
    const changeOrder = { isChangeOrder: true, assignedRepId: "u1" };
    expect(pipeline.canMoveStage(changeOrder, "u1")).toBe(true);
    expect(pipeline.stageMoveLock(changeOrder).locked).toBe(true);
  });
});

describe("getStagePage wire contract", () => {
  /**
   * Every name here was wrong on the first attempt, and the drill-down rendered "Nothing here" beside a
   * non-zero header total. Pinned against the server rather than against the sibling endpoints, which
   * spell all three differently.
   *
   * NOTE ON `pageSize`: a review suggested this parameter should be `limit`. It should not — the route's
   * readStageInput reads `req.query.pageSize` (deals/routes.ts:627) and never looks at `limit`, so
   * sending `limit` is silently ignored and every page comes back at the server default of 25. Verified
   * against the handler before writing this, because that is exactly the mistake being pinned.
   */
  it("reads rows, NOT deals — the field that made the drill-down look empty", async () => {
    const { fetcher } = recording({
      rows: [{ id: "d1", name: "Palm Villas" }],
      pagination: { page: 1, pageSize: 25, total: 40, totalPages: 2 },
      summary: { count: 30, activeCount: 30, totalCount: 40 },
    });
    const res = await pipeline.getStagePage(fetcher, "stage-1", { scope: "mine" });
    expect(res.deals).toHaveLength(1);
    expect(res.deals[0]).toMatchObject({ name: "Palm Villas" });
  });

  it("sends pageSize, the only paging name the route reads", async () => {
    const { fetcher, calls } = recording({ rows: [] });
    await pipeline.getStagePage(fetcher, "stage-1", { scope: "all", page: 3, pageSize: 50 });
    const query = calls[0].opts.query as Record<string, unknown>;
    expect(query.pageSize).toBe(50);
    expect(query.page).toBe(3);
    expect(query.scope).toBe("all");
    expect(query.limit).toBeUndefined();
  });

  it("drops a non-positive page rather than sending page=0", async () => {
    // apiFetch's query builder strips undefined but KEEPS 0, and page=0 is not a valid page.
    const { fetcher, calls } = recording({ rows: [] });
    await pipeline.getStagePage(fetcher, "stage-1", { scope: "mine", page: 0 });
    expect((calls[0].opts.query as Record<string, unknown>).page).toBeUndefined();
  });

  it("takes the total from summary.totalCount, which counts held cards too", async () => {
    // summary.count is ACTIVE-only; using it would under-report the very truncation this screen exists
    // to expose.
    const { fetcher } = recording({
      rows: [],
      summary: { count: 30, activeCount: 30, totalCount: 40 },
    });
    const res = await pipeline.getStagePage(fetcher, "stage-1", { scope: "mine" });
    expect(res.totalCount).toBe(40);
  });

  it("degrades to an empty list rather than undefined", async () => {
    const { fetcher } = recording({});
    const res = await pipeline.getStagePage(fetcher, "stage-1", { scope: "mine" });
    expect(res.deals).toEqual([]);
    expect(res.totalCount).toBeUndefined();
  });
});
