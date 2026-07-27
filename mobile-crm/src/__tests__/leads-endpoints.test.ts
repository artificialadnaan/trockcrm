import * as leads from "../api/endpoints/leads";
import { ApiError } from "../api/client";
import type { Fetcher } from "../api/endpoints/auth";

function recording(result: unknown = {}) {
  const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
  const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
    calls.push({ path, opts });
    return result;
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

function throwing(err: unknown) {
  const fetcher = (async () => {
    throw err;
  }) as unknown as Fetcher;
  return fetcher;
}

/**
 * The leads surface has the least uniform envelopes in the CRM API — four different shapes across seven
 * endpoints — so each one is pinned against its route rather than inferred from the last.
 */
describe("lead envelopes", () => {
  it("GET /leads unwraps { leads }", async () => {
    const { fetcher } = recording({ leads: [{ id: "l1", name: "Palm Villas roof" }] });
    await expect(leads.listLeads(fetcher)).resolves.toHaveLength(1);
  });

  it("GET /leads degrades to an empty list rather than undefined", async () => {
    const { fetcher } = recording({});
    await expect(leads.listLeads(fetcher)).resolves.toEqual([]);
  });

  it("GET /leads/:id unwraps { lead } — returning the envelope leaves every field undefined", async () => {
    const { fetcher } = recording({ lead: { id: "l1", name: "Palm Villas roof" } });
    await expect(leads.getLead(fetcher, "l1")).resolves.toMatchObject({ name: "Palm Villas roof" });
  });

  it("GET /leads/stages unwraps { stages } — iterating the envelope throws", async () => {
    const { fetcher } = recording({ stages: [{ id: "s1", name: "New" }] });
    await expect(leads.listLeadStages(fetcher)).resolves.toHaveLength(1);
  });

  it("hits the LEAD stages endpoint, not the deal one — different workflow family", async () => {
    const { fetcher, calls } = recording({ stages: [] });
    await leads.listLeadStages(fetcher);
    expect(calls[0].path).toBe("/leads/stages");
  });

  it("POST /leads/:id/convert returns lead AND deal at the TOP LEVEL, with no envelope", async () => {
    const { fetcher } = recording({ lead: { id: "l1" }, deal: { id: "d1", dealNumber: "TR-2026-0007" } });
    const res = await leads.convertLead(fetcher, "l1");
    expect(res.lead.id).toBe("l1");
    expect(res.deal.dealNumber).toBe("TR-2026-0007");
  });
});

describe("list query shape", () => {
  it("comma-joins stageIds, the form the route splits on", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher, { stageIds: ["a", "b"] });
    expect((calls[0].opts.query as Record<string, unknown>).stageIds).toBe("a,b");
  });

  it("omits an empty stageIds rather than sending a blank filter", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher, { stageIds: [] });
    expect((calls[0].opts.query as Record<string, unknown>).stageIds).toBeUndefined();
  });

  it("trims a search term and drops a blank one", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher, { search: "  villas  " });
    expect((calls[0].opts.query as Record<string, unknown>).search).toBe("villas");

    const second = recording({ leads: [] });
    await leads.listLeads(second.fetcher, { search: "   " });
    expect((second.calls[0].opts.query as Record<string, unknown>).search).toBeUndefined();
  });

  /**
   * The route caps rows only when a limit is ASKED for; with none it returns the full set, because
   * aggregate callers depend on that. A phone must always ask.
   */
  it("always sends a limit — an unbounded leads query is the server's default", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher);
    expect((calls[0].opts.query as Record<string, unknown>).limit).toBe(100);
  });

  it("never sends a page — this endpoint has no pagination to send one to", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher, { scope: "all" });
    expect((calls[0].opts.query as Record<string, unknown>).page).toBeUndefined();
  });
});

describe("stage transition", () => {
  it("returns a success result as-is — the body IS the result, with no envelope", async () => {
    const { fetcher } = recording({ ok: true, lead: { id: "l1", stageId: "s2" } });
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(true);
  });

  /**
   * The load-bearing one. A refusal arrives as HTTP 409 carrying the useful payload — the list of what
   * the lead still needs. apiFetch throws on any non-2xx, so without this the most informative response
   * the endpoint produces would surface as a generic error and the caller would render nothing.
   */
  it("turns a 409 refusal into a VALUE, not an exception", async () => {
    const fetcher = throwing(new ApiError("Missing requirements", 409, "MISSING_REQUIREMENTS"));
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("MISSING_REQUIREMENTS");
      expect(res.targetStageId).toBe("s2");
    }
  });

  it("still throws on a real failure — a 500 is not a refusal", async () => {
    const fetcher = throwing(new ApiError("Boom", 500));
    await expect(leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("still throws when offline, rather than reporting a refusal that never happened", async () => {
    const fetcher = throwing(new ApiError("Network request failed", 0));
    await expect(leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("isLeadOpen", () => {
  /**
   * `status` and `isActive` are independent axes, and a converted lead keeps its name, stage and rep —
   * so "has a stage" is not "can be worked". Converted and disqualified leads stay READABLE (that is how
   * a rep finds the deal a lead became) but must never be offered a stage move.
   */
  it("treats a plain open lead as open", () => {
    expect(leads.isLeadOpen({ status: "open", isActive: true })).toBe(true);
    expect(leads.isLeadOpen({})).toBe(true);
  });

  it("closes a converted lead even though it is otherwise intact", () => {
    expect(leads.isLeadOpen({ status: "converted", isActive: true })).toBe(false);
  });

  it("closes a disqualified lead", () => {
    expect(leads.isLeadOpen({ status: "disqualified", isActive: true })).toBe(false);
  });

  it("closes an inactive lead whatever its status says", () => {
    expect(leads.isLeadOpen({ status: "open", isActive: false })).toBe(false);
  });
});
