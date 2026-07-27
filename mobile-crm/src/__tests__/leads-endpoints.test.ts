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

  it("sends `name` to rename the successor deal — `dealName` is silently ignored", async () => {
    // The conversion service reads input.name; the route forwards unknown keys untranslated, so the
    // wrong one produced a SUCCESSFUL conversion whose deal quietly kept the lead's name.
    const { fetcher, calls } = recording({ lead: { id: "l1" }, deal: { id: "d1" } });
    await leads.convertLead(fetcher, "l1", { name: "Palm Villas re-roof" });
    expect(calls[0].opts.body).toEqual({ name: "Palm Villas re-roof" });
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

  /**
   * BOTH conversion and disqualification set is_active = false, and the route defaults to true — so the
   * server's default silently hides every terminal lead, making the converted/disqualified badges and
   * the converted-deal link unreachable, and `status: "converted"` return nothing.
   */
  it("asks for inactive rows too, or terminal leads are invisible", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher);
    expect((calls[0].opts.query as Record<string, unknown>).isActive).toBe("all");
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

  /**
   * The itemised list is the POINT of the 409, and the first version of this adapter threw it away —
   * rebuilding a refusal with `missing: []`, so the detail screen's entire requirements view could
   * never receive data and always fell through to a generic message.
   */
  it("returns the SERVER's refusal, itemised requirements and all", async () => {
    const serverRefusal = {
      ok: false,
      reason: "missing_requirements",
      code: "MISSING_REQUIREMENTS",
      targetStageId: "s2",
      resolution: "detail",
      missing: [
        { key: "leadScoping.roofType", label: "Roof type", resolution: "detail" },
        { key: "estimatedValue", label: "Estimated value", resolution: "inline" },
      ],
    };
    const fetcher = throwing(new ApiError("Missing requirements", 409, "MISSING_REQUIREMENTS", serverRefusal));
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toHaveLength(2);
      expect(res.missing?.[0]).toMatchObject({ label: "Roof type", resolution: "detail" });
    }
  });

  it("still yields a refusal when the 409 body could not be read", async () => {
    // A 409 is a refusal whether or not we could parse why — it must never read as a success.
    const fetcher = throwing(new ApiError("Conflict", 409, undefined, undefined));
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
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

describe("nextLeadStage", () => {
  const stages = [
    { id: "s1", slug: "new_lead", displayOrder: 1, isActivePipeline: true },
    { id: "s2", slug: "qualified", displayOrder: 2, isActivePipeline: true },
    { id: "s3", slug: "validation", displayOrder: 3, isActivePipeline: true },
  ];

  /**
   * A forward move of more than one canonical stage is a hard 409 (LEAD_STAGE_PROGRESSION_GAP), so a
   * picker of "every stage but the current one" offered mostly guaranteed failures beside the single
   * legal target. The web narrows the same way.
   */
  it("offers exactly the following stage", () => {
    expect(leads.nextLeadStage(stages, "s1")?.id).toBe("s2");
    expect(leads.nextLeadStage(stages, "s2")?.id).toBe("s3");
  });

  it("offers nothing at the end of the pipeline", () => {
    expect(leads.nextLeadStage(stages, "s3")).toBeNull();
  });

  it("orders by displayOrder, not array order", () => {
    const shuffled = [stages[2], stages[0], stages[1]];
    expect(leads.nextLeadStage(shuffled, "s1")?.id).toBe("s2");
  });

  it("skips a retired stage rather than making it the next target", () => {
    // A retired stage mid-pipeline would otherwise be offered and rejected by the write guard.
    const withRetired = [
      stages[0],
      { id: "gone", slug: "legacy", displayOrder: 2, isActivePipeline: false },
      { ...stages[1], displayOrder: 3 },
    ];
    expect(leads.nextLeadStage(withRetired, "s1")?.id).toBe("s2");
  });

  it("returns null for an unknown or missing current stage", () => {
    expect(leads.nextLeadStage(stages, "nope")).toBeNull();
    expect(leads.nextLeadStage(stages, null)).toBeNull();
  });
});

describe("409s that are not missing-requirements", () => {
  /**
   * The transition path also 409s for a progression gap and for a lead that went terminal after the
   * screen loaded. Normalising those into a requirements refusal told the rep to complete information
   * that was not the problem, and left a stale screen looking workable.
   */
  it("re-throws a progression-gap conflict instead of calling it missing requirements", async () => {
    const fetcher = throwing(
      new ApiError("Lead stage progression must move one canonical stage at a time", 409, "LEAD_STAGE_PROGRESSION_GAP"),
    );
    await expect(leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s3" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("still normalizes a coded missing-requirements conflict", async () => {
    const fetcher = throwing(new ApiError("Missing requirements", 409, "MISSING_REQUIREMENTS"));
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
  });

  it("prefers the SERVER's body over the code, when it sent one", async () => {
    // A refusal body wins even under an unfamiliar code — it is the server's own answer.
    const body = { ok: false, reason: "missing_requirements", missing: [{ key: "a", label: "A", resolution: "inline" }] };
    const fetcher = throwing(new ApiError("Conflict", 409, "SOMETHING_ELSE", body));
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toHaveLength(1);
  });
});
