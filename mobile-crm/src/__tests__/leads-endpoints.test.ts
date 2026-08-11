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
  /**
   * ACTIVE by default. Defaulting to "all" made terminal leads reachable and created a worse problem:
   * the route caps at 100 rows by updatedAt and a lead is updated at the moment it converts, so a busy
   * week of conversions can fill the response and push older OPEN leads out of a list with no
   * pagination — making the actionable ones the unreachable ones.
   */
  it("defaults to ACTIVE so terminal rows cannot evict open leads", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher);
    expect((calls[0].opts.query as Record<string, unknown>).isActive).toBe("true");
  });

  it("reaches terminal leads when they are asked for explicitly", async () => {
    const { fetcher, calls } = recording({ leads: [] });
    await leads.listLeads(fetcher, { isActive: "false" });
    expect((calls[0].opts.query as Record<string, unknown>).isActive).toBe("false");
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
    // The refusal RESULT itself, which is what the route sends when preflight refuses.
    const fetcher = throwing(
      new ApiError("Missing requirements", 409, "MISSING_REQUIREMENTS", {
        ok: false,
        reason: "missing_requirements",
        targetStageId: "s2",
        missing: [],
      }),
    );
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.targetStageId).toBe("s2");
  });

  /**
   * The OTHER refusal shape. When preflight passed and updateLead then rejected the move, the route
   * answers with a nested envelope under a different code — reachable, and previously re-thrown, so the
   * detail screen showed a bare message and dropped the itemised remediation.
   */
  it("normalizes the nested LEAD_STAGE_REQUIREMENTS_UNMET envelope too", async () => {
    /**
     * THE SHAPE THE TRANSITION ACTUALLY SENDS — three flat string arrays.
     *
     * This fixture previously carried `missingRequirements.effectiveChecklist.fields`, which belongs to
     * the PREFLIGHT gate (stage-gate.ts:307-317), not to this error. The test passed because it was
     * written from the same wrong assumption as the code it was checking: both read a field the server
     * never sends here, and agreeing with each other is not the same as agreeing with the server. Pinned
     * against stage-transition-service.ts:34-38 and routes.ts:541-549 instead.
     */
    const fetcher = throwing(
      new ApiError("Requirements unmet", 409, "LEAD_STAGE_REQUIREMENTS_UNMET", {
        error: {
          code: "LEAD_STAGE_REQUIREMENTS_UNMET",
          missingRequirements: {
            prerequisiteFields: ["source", "projectTypeId"],
            qualificationFields: ["qualification_budget"],
            projectTypeQuestionIds: ["q-roof-age"],
          },
        },
      }),
    );
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // All three arrays, flattened in order — the web normalizer's contract (use-leads.ts:657-661).
      expect(res.missing?.map((item) => item.key)).toEqual([
        "source",
        "projectTypeId",
        "qualification_budget",
        "q-roof-age",
      ]);
      expect(res.missing?.[0]).toMatchObject({ key: "source", label: "source", resolution: "detail" });
    }
  });

  it("survives a nested refusal that names only one of the three arrays", async () => {
    // The qualified_lead gate returns prerequisiteFields with the other two empty; the sales-validation
    // gate returns the other two with prerequisiteFields empty. Neither shape may drop to `missing: []`.
    const fetcher = throwing(
      new ApiError("Requirements unmet", 409, "LEAD_STAGE_REQUIREMENTS_UNMET", {
        error: {
          code: "LEAD_STAGE_REQUIREMENTS_UNMET",
          missingRequirements: { prerequisiteFields: ["source"] },
        },
      }),
    );
    const res = await leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing?.map((item) => item.key)).toEqual(["source"]);
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

  /**
   * An UNCODED 409 is a stale-screen conflict, not a requirements refusal — updateLead rejects a
   * converted, disqualified or archived lead with plain messages and no code. Fabricating a
   * missing-requirements result for those routed them through onSuccess, skipped the refresh onError
   * performs, and told the rep to complete fields that do not exist.
   */
  it("re-throws a 409 whose payload does not identify a requirements refusal", async () => {
    const fetcher = throwing(new ApiError("Hidden lead records are read-only", 409, undefined, undefined));
    await expect(leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" })).rejects.toBeInstanceOf(
      ApiError,
    );
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

/**
 * The two adapters that had no contract test, in a file whose whole premise is that each envelope is
 * pinned against its route because the leads surface's shapes do not follow each other.
 *
 * `watchLead` is the sharper of the two: its entire behaviour is a `watching ? "POST" : "DELETE"`
 * ternary, so inverting it is a one-character edit that changes watch into unwatch with nothing to
 * catch it and no error at either end — the request succeeds, it just does the opposite thing.
 */
describe("preflight and watch", () => {
  it("POSTs the target stage to the preflight route and returns the GATE result, not a transition result", async () => {
    // Different function, different shape: preflight answers `allowed` / `missingRequirements`, and has
    // no `ok` at all. Typing it as the transition result made every `ok` check silently falsy.
    const { fetcher, calls } = recording({
      allowed: false,
      blockReason: "Lead stage change not allowed until required intake is complete",
      missingRequirements: {
        fields: ["source"],
        effectiveChecklist: { fields: [{ key: "source", label: "Source", satisfied: false }] },
      },
    });

    const res = await leads.preflightLeadStage(fetcher, "l1", "s2");

    expect(calls[0].path).toBe("/leads/l1/stage/preflight");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.body).toEqual({ targetStageId: "s2" });
    expect(res.allowed).toBe(false);
    // The PREFLIGHT is the shape that really does carry effectiveChecklist — the transition error does
    // not, and reading this one there is what dropped every itemised refusal.
    expect(res.missingRequirements?.effectiveChecklist?.fields?.[0]).toMatchObject({ key: "source" });
  });

  it("POSTs to watch and DELETEs to unwatch — the same path, opposite verbs", async () => {
    const { fetcher, calls } = recording({});
    await leads.watchLead(fetcher, "l1", true);
    await leads.watchLead(fetcher, "l1", false);

    expect(calls.map((call) => [call.path, call.opts.method])).toEqual([
      ["/leads/l1/watch", "POST"],
      ["/leads/l1/watch", "DELETE"],
    ]);
  });
});

describe("isLeadArchived", () => {
  /**
   * The third lifecycle state, and the one with no field of its own.
   *
   * Archiving clears is_active and LEAVES status at "open" (leads/service.ts:2202-2210), so these rows
   * are "not open" by isLeadOpen and "open" by their own status — which is how the detail screen came to
   * say "This lead is open. Its stage can no longer be changed."
   */
  it("recognises the archive tombstone: inactive but still status open", () => {
    expect(leads.isLeadArchived({ status: "open", isActive: false })).toBe(true);
  });

  it("is NOT archived for converted or disqualified leads, which are inactive on purpose", () => {
    expect(leads.isLeadArchived({ status: "converted", isActive: false })).toBe(false);
    expect(leads.isLeadArchived({ status: "disqualified", isActive: false })).toBe(false);
  });

  it("is NOT archived for a live open lead", () => {
    expect(leads.isLeadArchived({ status: "open", isActive: true })).toBe(false);
    expect(leads.isLeadArchived({})).toBe(false);
  });
});

describe("mergeLeadDetail", () => {
  /**
   * A raw write response folded into a decorated cache entry.
   *
   * `projectType` is the trap: a legacy TEXT column on the row AND a `{ id, name }` object on a
   * decorated read. A plain `{ ...previous, ...raw }` therefore replaced the object with a string, so
   * "Project type" blanked on every stage move — and stayed blank if the follow-up refetch failed,
   * because the screen deliberately keeps the merged copy as its saved state.
   */
  const decorated = {
    id: "l1",
    name: "Palm Villas roof",
    stageId: "s1",
    status: "open",
    projectType: { id: "pt1", name: "Re-roof" },
    property: { id: "p1", name: "Palm Villas", address: null, city: "Dallas", state: "TX" },
    companyName: "Palm Villas HOA",
    assignedRepName: "Dana",
    stageName: "New lead",
  } as unknown as Parameters<typeof leads.mergeLeadDetail>[0];

  const rawRow = {
    id: "l1",
    name: "Palm Villas roof",
    stageId: "s2",
    status: "open",
    updatedAt: "2026-07-27T00:00:00.000Z",
    // The COLUMN, not the decorated object.
    projectType: "re_roof",
  } as unknown as Parameters<typeof leads.mergeLeadDetail>[1];

  it("takes the moved stage from the response", () => {
    expect(leads.mergeLeadDetail(decorated, rawRow)).toMatchObject({
      stageId: "s2",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });
  });

  it("keeps the decorated projectType OBJECT rather than the raw column that shares its name", () => {
    const merged = leads.mergeLeadDetail(decorated, rawRow);
    expect(merged.projectType).toEqual({ id: "pt1", name: "Re-roof" });
  });

  it("keeps every other decorated field the raw row simply does not carry", () => {
    expect(leads.mergeLeadDetail(decorated, rawRow)).toMatchObject({
      companyName: "Palm Villas HOA",
      assignedRepName: "Dana",
      stageName: "New lead",
      property: { id: "p1", city: "Dallas" },
    });
  });

  it("never surfaces the raw column as a decorated field when there is no cache entry", () => {
    // With nothing to merge into there is no object to keep — but handing the screen a STRING under a
    // field it reads as `projectType?.name` would be worse than absent, so the raw value is dropped.
    expect(leads.mergeLeadDetail(undefined, rawRow).projectType).toBeUndefined();
  });
});

describe("listClosedLeads", () => {
  /**
   * Two requests, because "closed" is not "inactive".
   *
   * Archive tombstones are inactive with an "open" status, and the server sorts by updatedAt and caps at
   * 100 BEFORE the client sees anything — so a client-side status filter could not recover the converted
   * and disqualified leads a page full of tombstones had already pushed out.
   */
  function multiRecording(results: unknown[]) {
    const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
    let index = 0;
    const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
      calls.push({ path, opts });
      return results[index++] ?? {};
    }) as unknown as Fetcher;
    return { fetcher, calls };
  }

  it("asks for the two terminal statuses separately — the route's status filter is a single equality", async () => {
    const { fetcher, calls } = multiRecording([{ leads: [] }, { leads: [] }]);
    await leads.listClosedLeads(fetcher, { scope: "mine" });

    const statuses = calls.map((call) => (call.opts.query as Record<string, unknown>).status);
    expect(statuses).toEqual(["converted", "disqualified"]);
    // Each capped independently, so neither status can crowd the other out.
    for (const call of calls) {
      expect((call.opts.query as Record<string, unknown>).limit).toBe(100);
      expect((call.opts.query as Record<string, unknown>).scope).toBe("mine");
    }
  });

  it("does not filter on isActive, which is the axis that let tombstones in", async () => {
    const { fetcher, calls } = multiRecording([{ leads: [] }, { leads: [] }]);
    await leads.listClosedLeads(fetcher);
    for (const call of calls) {
      expect((call.opts.query as Record<string, unknown>).isActive).toBe("all");
    }
  });

  it("merges both statuses onto the one updatedAt axis the server sorts by", async () => {
    const { fetcher } = multiRecording([
      { leads: [{ id: "c1", updatedAt: "2026-07-01T00:00:00.000Z" }] },
      { leads: [{ id: "d1", updatedAt: "2026-07-20T00:00:00.000Z" }] },
    ]);
    const rows = await leads.listClosedLeads(fetcher);
    // Newest first ACROSS the two responses — concatenating them would have shown every converted lead
    // before every disqualified one regardless of date.
    expect(rows.map((row) => row.id)).toEqual(["d1", "c1"]);
  });

  it("returns no archive tombstones, because it never asks for status open", async () => {
    const { fetcher, calls } = multiRecording([{ leads: [] }, { leads: [] }]);
    await leads.listClosedLeads(fetcher);
    expect(calls.some((call) => (call.opts.query as Record<string, unknown>).status === "open")).toBe(false);
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

  it("re-throws a bare MISSING_REQUIREMENTS code with no payload to itemise", async () => {
    // The code alone cannot be acted on; re-throwing routes it through onError, which refreshes.
    const fetcher = throwing(new ApiError("Missing requirements", 409, "MISSING_REQUIREMENTS"));
    await expect(leads.transitionLeadStage(fetcher, "l1", { targetStageId: "s2" })).rejects.toBeInstanceOf(
      ApiError,
    );
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
