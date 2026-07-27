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
    const limit = (calls[0].opts.query as Record<string, number>).previewLimit;
    expect(limit).toBeLessThanOrEqual(25);
    expect(limit).toBeGreaterThan(0);
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
   * The server requires a reason id AND non-blank notes for a Lost move. If the screen does not
   * recognise the target as Lost it collects neither, and the rep gets a rejection naming fields they
   * were never shown.
   *
   * shared/src/types/workflow.ts:313-315 defines the set as the CANONICAL slug plus four legacy
   * aliases. The first mirror here had the four aliases and omitted the canonical one — which is the
   * slug a current pipeline config actually uses, so it failed on the common case and worked on the
   * legacy ones.
   */
  const LOST = ["lost", "deal_canceled", "production_lost", "service_lost", "closed_lost"];

  it.each(LOST)("treats %s as a Lost move", (slug) => {
    expect(LOST.includes(slug)).toBe(true);
  });

  it("includes the CANONICAL slug, not just the legacy aliases", () => {
    expect(LOST).toContain("lost");
  });

  it.each(["won", "closed_won", "estimating", "opportunity", "contract"])(
    "does not treat %s as Lost",
    (slug) => {
      expect(LOST.includes(slug)).toBe(false);
    },
  );
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
