// `resolveGlassesWalkthroughScope` against a STUBBED TROCK Scope.
//
// This is the half of the AI-walk panel where every interesting case is a FAILURE case, so the stub is the
// point rather than a convenience: TROCK Scope being down, slow, refusing the CRM's credential, or
// answering about a walkthrough it has never heard of are all states this endpoint has to render, and none
// of them may become a non-200 or a hung deal page. There is no database here at all — that is the shape of
// the code (the route commits and releases its pooled connection between the row read and this call), and
// the row read has its own real-SQL suite in glasses-walkthrough-scope-service.runtime.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  GLASSES_WALKTHROUGH_SCOPE_CONCURRENCY,
  GLASSES_WALKTHROUGH_SCOPE_TIMEOUT_MS,
  __resetGlassesWalkthroughScopeWarningsForTest,
  resolveGlassesWalkthroughScope,
  type GlassesWalkthroughRow,
  type GlassesWalkthroughScopeReader,
} from "./glasses-walkthrough-scope-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ROW_ID = U("aaa1");
const USER = U("22222");
const SCOPE_ID = "b91a5bfd-1111-4222-8333-444455556666";

function row(overrides: Partial<GlassesWalkthroughRow> = {}): GlassesWalkthroughRow {
  return {
    id: ROW_ID,
    walkId: "walk-msc4vvy4-m7r30urh",
    scopeWalkthroughId: SCOPE_ID,
    capturedAt: new Date("2026-08-02T22:21:47.702Z"),
    capturedByUserId: USER,
    capturedByName: "Dana Reyes",
    captureCensus: null,
    ...overrides,
  };
}

/** The census of a walk that went badly: 30 min on the clock, 26.2 min of glasses audio, 25 min standalone. */
function census(): NonNullable<GlassesWalkthroughRow["captureCensus"]> {
  return {
    walkMs: 1_800_000,
    video: { framesReceived: 54_000, framesAppended: 1_800, framesDropped: 52_200, secondsSinceLastFrameArrived: 1_740.5 },
    audio: {
      buffersReceived: 90_000,
      buffersAppended: 78_600,
      buffersDropped: 11_400,
      longestDropRun: 11_400,
      secondsAppended: 1_572,
      engineRestarts: 2,
      standaloneSecondsRecorded: 1_500,
      events: [{ atMs: 60_000, kind: "video-stalled" }],
    },
  };
}

/** One TROCK Scope scope item in the shape `GET /api/walkthroughs/:id/scope-items` really returns
 *  (shared/src/review/queues.ts in that repo), trimmed to the fields the panel maps. */
function scopeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "1f0c0a6e-2222-4333-8444-555566667777",
    trade: "painting",
    description: "Paint wall red",
    quantity: 700,
    unit: "SF",
    confidence: 0.78,
    ...overrides,
  };
}

function reader(overrides: Partial<GlassesWalkthroughScopeReader> = {}): GlassesWalkthroughScopeReader {
  return {
    isConfigured: () => true,
    fetchScopeItemEvidence: overrides.fetchScopeItemEvidence ?? (async () => null),
    fetchScopeItems: async () => ({ outcome: "found", items: [scopeItem()], pipeline: "finished" }),
    ...overrides,
  };
}

/** Silences the operational warnings this module emits and lets a test assert on them. */
function collectWarnings() {
  const lines: string[] = [];
  return { warn: (message: string) => lines.push(message), lines };
}

describe("resolveGlassesWalkthroughScope — TROCK Scope's pipeline health", () => {
  // The field is DECORATION on a page estimators keep open all day, and that fixes every rule below: no
  // shape TROCK Scope can send may cost the panel its line items, and nothing absent may be invented.
  const withHealth = (pipelineHealth: unknown) =>
    reader({
      fetchScopeItems: async () => ({ outcome: "found", items: [scopeItem()], pipeline: "finished", pipelineHealth }),
    });

  it("carries a well-formed health object onto the entry", async () => {
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: withHealth({
        state: "held",
        stage: "grounding",
        reason: "no active work-type catalog for job type service_repair",
        since: "2026-09-02T10:00:00.000Z",
      }),
      warn: collectWarnings().warn,
    });

    expect(entry!.pipeline).toEqual({
      state: "held",
      stage: "grounding",
      reason: "no active work-type catalog for job type service_repair",
      since: "2026-09-02T10:00:00.000Z",
    });
  });

  it("reads a state this build has never heard of, rather than refusing it", async () => {
    // The vocabulary is TROCK Scope's and grows without asking. A build that dropped an unrecognised
    // state would go silent on exactly the walks a new state was introduced to describe.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: withHealth({ state: "quarantined" }),
      warn: collectWarnings().warn,
    });

    expect(entry!.pipeline).toEqual({ state: "quarantined", stage: null, reason: null, since: null });
  });

  it("degrades each optional field on its own", async () => {
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: withHealth({ state: "failed", stage: "", reason: 42, since: null }),
      warn: collectWarnings().warn,
    });

    expect(entry!.pipeline).toEqual({ state: "failed", stage: null, reason: null, since: null });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["not an object", "held"],
    ["an object with no state", { stage: "grounding", reason: "why" }],
    ["an object whose state is blank", { state: "   " }],
  ])("reports NO health, without failing the panel, when it is %s", async (_label, pipelineHealth) => {
    // `state` is the whole claim; the rest decorates it. A health object that does not say how the walk is
    // doing has nothing to render, and rendering the stage alone would be a chip that says nothing.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: withHealth(pipelineHealth),
      warn: collectWarnings().warn,
    });

    expect(entry!.pipeline).toBeNull();
    // The line items are what the estimator came for and they survive every one of these.
    expect(entry!.scope?.items).toHaveLength(1);
    expect(entry!.state).toBe("ready");
  });

  it("is recorded even when the walk resolves to a state OTHER than ready", async () => {
    // A walk whose scope came back empty and unfinished is reported `processing` — and it is exactly the
    // walk whose "what is that service actually doing?" is most worth answering.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          items: [],
          pipeline: "working",
          pipelineHealth: { state: "processing", stage: "transcribe" },
        }),
      }),
      warn: collectWarnings().warn,
    });

    expect(entry!.state).toBe("processing");
    expect(entry!.pipeline).toEqual({ state: "processing", stage: "transcribe", reason: null, since: null });
  });

  it("stays null for a walk that was never asked about", async () => {
    // No remote walkthrough yet, so no request is made at all. Null here means "we did not hear", which
    // is the only honest answer and is why the chip is absent rather than showing an invented state.
    const [entry] = await resolveGlassesWalkthroughScope([row({ scopeWalkthroughId: null })], {
      scopeReader: reader(),
      warn: collectWarnings().warn,
    });

    expect(entry!.pipeline).toBeNull();
    expect(entry!.state).toBe("processing");
  });
});

describe("resolveGlassesWalkthroughScope — the four states", () => {
  it('SUCCESS: a walk TROCK Scope answers for is "ready" and carries its items', async () => {
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], { scopeReader: reader(), warn });

    expect(entry).toEqual({
      id: ROW_ID,
      walkId: "walk-msc4vvy4-m7r30urh",
      scopeWalkthroughId: SCOPE_ID,
      capturedAt: "2026-08-02T22:21:47.702Z",
      capturedByUserId: USER,
      // Carried through the network phase untouched. The name is resolved once, in the DB read that
      // happens BEFORE the commit; nothing out here re-reads a user, so a TROCK Scope outage cannot cost
      // the heading its capturer.
      capturedByName: "Dana Reyes",
      // No census on this row, so both are null — "we do not know", which is not the same as zero lost.
      captureCensus: null,
      narrationShortfallMs: null,
      // TROCK Scope's health object, null because this fixture's answer carries none — the shape of every
      // real response until that service ships the field.
      pipeline: null,
      state: "ready",
      scope: {
        status: "ready",
        items: [
          {
            id: "1f0c0a6e-2222-4333-8444-555566667777",
            // NULL rather than the uuid TROCK Scope's `/scope-items` returns as `workTypeId` today. A uuid
            // in a column labelled with a human work-type code looks like data; a blank does not.
            workTypeCode: null,
            description: "Paint wall red",
            trade: "painting",
            quantity: 700,
            unit: "SF",
            confidence: 0.78,
            // The detail the panel is built on. Absent from this fixture's response, so each one is the
            // documented default rather than a value — which is the point: an older TROCK Scope build
            // that says nothing about location or provenance must degrade to blanks, never to a
            // confident-looking claim the estimator would act on.
            locationLabel: null,
            evidence: [],
            quantitySource: null,
            status: null,
            lowVisualConfidence: false,
            hasOpenConflict: false,
          },
        ],
      },
    });
  });

  it("attaches the CITATIONS — quote, stills and clip — to each row", async () => {
    // The reason the panel is worth opening. `description` is the model's reading of an utterance;
    // the quote is the utterance, and the frames are what it was said over. An estimator deciding
    // whether to trust a line is really asking "what did they say, and what were they looking at".
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({ outcome: "found", pipeline: "finished", items: [scopeItem()] }),
        fetchScopeItemEvidence: async () => [
          {
            quote: "paint this whole wall red",
            clipId: "861159f0-c048-4441-8489-85f31bfd3276",
            timelineMs: 4200,
            mentionedQuantity: 700,
            mentionedUnit: "SF",
            clipProxyUrl: "https://example.test/clip.mp4?sig=1",
            frames: [
              { url: "https://example.test/frame-1.jpg?sig=1", timelineMs: 4200 },
              { url: "https://example.test/frame-2.jpg?sig=1", timelineMs: 4800 },
            ],
          },
        ],
      }),
      warn: collectWarnings().warn,
    });

    const [item] = entry!.scope!.items;
    expect(item!.evidence).toHaveLength(1);
    expect(item!.evidence[0]!.quote).toBe("paint this whole wall red");
    expect(item!.evidence[0]!.frames.map((frame) => frame.url)).toEqual([
      "https://example.test/frame-1.jpg?sig=1",
      "https://example.test/frame-2.jpg?sig=1",
    ]);
    expect(item!.evidence[0]!.clipUrl).toBe("https://example.test/clip.mp4?sig=1");
    // The number as SPOKEN, which is not always the row's resolved quantity.
    expect(item!.evidence[0]!.mentionedQuantity).toBe(700);
  });

  it("KEEPS the scope when the evidence pass runs out the deadline", async () => {
    // The regression: `entry.scope` used to be assigned AFTER awaiting the citations, so a slow
    // thumbnail could lose the race to the phase timeout and the walk was reported `unavailable` with
    // no items — hiding a scope we had already successfully read, in order to wait for pictures that
    // only corroborate it. The rows are committed first now; citations decorate what is already there.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({ outcome: "found", pipeline: "finished", items: [scopeItem()] }),
        // Never settles on its own: only the deadline ends it.
        fetchScopeItemEvidence: () => new Promise(() => {}),
      }),
      timeoutMs: 20,
      warn: collectWarnings().warn,
    });

    expect(entry!.state).toBe("ready");
    expect(entry!.scope!.items).toHaveLength(1);
    expect(entry!.scope!.items[0]!.description).toBe("Paint wall red");
  });

  it("ADDS media to the baseline citations instead of replacing them", async () => {
    // The two responses are not interchangeable: `/scope-items` carries every mention, the evidence
    // call carries them WITH pictures. `toPanelEvidence` drops malformed entries independently, so
    // overwriting meant one bad entry in an otherwise good answer replaced the complete baseline with
    // a subset — silently deleting quotes that were perfectly readable.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [
            scopeItem({
              evidence: [
                { quote: "paint this wall red", clipId: "c1", timelineMs: 1000 },
                { quote: "and replace the vinyl", clipId: "c1", timelineMs: 5000 },
              ],
            }),
          ],
        }),
        // Only ONE of the two mentions comes back usable.
        fetchScopeItemEvidence: async () => [
          {
            quote: "paint this wall red",
            clipId: "c1",
            timelineMs: 1000,
            frames: [{ url: "https://scope.test/f1.jpg?sig=1", timelineMs: 1000 }],
            clipProxyUrl: "https://scope.test/clip.mp4?sig=1",
          },
          { clipId: "c1", timelineMs: 5000 },
        ],
      }),
      warn: collectWarnings().warn,
    });

    const evidence = entry!.scope!.items[0]!.evidence;
    // BOTH quotes survive; the one with media gains it.
    expect(evidence.map((mention) => mention.quote)).toEqual([
      "paint this wall red",
      "and replace the vinyl",
    ]);
    expect(evidence[0]!.frames.map((frame) => frame.url)).toEqual(["https://scope.test/f1.jpg?sig=1"]);
    expect(evidence[0]!.clipUrl).toBe("https://scope.test/clip.mp4?sig=1");
    expect(evidence[1]!.frames).toEqual([]);
  });

  it("does NOT let the richer response rewrite what was said", async () => {
    // The evidence call wins on MEDIA only. A truncated or re-worded copy of a quote in the richer
    // response must not quietly become the record of what somebody said on site.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [scopeItem({ evidence: [{ quote: "paint this whole wall red", clipId: "c1", timelineMs: 1000 }] })],
        }),
        fetchScopeItemEvidence: async () => [
          { quote: "paint wall", clipId: "c1", timelineMs: 1000, frames: [], clipProxyUrl: null },
        ],
      }),
      warn: collectWarnings().warn,
    });

    expect(entry!.scope!.items[0]!.evidence[0]!.quote).toBe("paint this whole wall red");
  });

  it("makes NO evidence request from a task the limiter admits AFTER the deadline", async () => {
    // The limiter queues once its ceiling is reached, so a task can be admitted long after the phase
    // ended — opening a request nobody is waiting on, against a service this endpoint already polls.
    //
    // Built so the queue genuinely drains post-deadline: more items than the concurrency ceiling, an
    // evidence reader that outlives the timeout, and an assertion taken after the queued slots would
    // have run. An earlier version of this test set a 1ms deadline and a slow scope read — it passed
    // with the guard REMOVED, because evidence was never queued at all, and proved nothing.
    const itemCount = GLASSES_WALKTHROUGH_SCOPE_CONCURRENCY + 2;
    let calls = 0;
    await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: Array.from({ length: itemCount }, (_, index) =>
            scopeItem({ id: `1f0c0a6e-2222-4333-8444-00000000000${index}` })
          ),
        }),
        fetchScopeItemEvidence: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return null;
        },
      }),
      timeoutMs: 15,
      warn: collectWarnings().warn,
    });

    // The first batch was already in flight when the deadline fired; only the ceiling may have run.
    expect(calls).toBe(GLASSES_WALKTHROUGH_SCOPE_CONCURRENCY);

    // Let the in-flight batch finish, which is when the queued slots would otherwise be admitted.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(GLASSES_WALKTHROUGH_SCOPE_CONCURRENCY);
  });

  it("still renders the scope when the citations cannot be fetched", async () => {
    // THE WHOLE POINT OF THE BEST-EFFORT CONTRACT. The line items are the panel; the pictures
    // corroborate them. A signing failure or a timeout on a thumbnail must not collapse the walk to
    // `unavailable` and hide work TROCK Scope did perfectly well.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({ outcome: "found", pipeline: "finished", items: [scopeItem()] }),
        fetchScopeItemEvidence: async () => null,
      }),
      warn: collectWarnings().warn,
    });

    expect(entry!.state).toBe("ready");
    expect(entry!.scope!.items).toHaveLength(1);
    expect(entry!.scope!.items[0]!.evidence).toEqual([]);
  });

  it("does NOT let an empty evidence answer delete the quotes /scope-items already gave", async () => {
    // The two responses overlap: `/scope-items` carries the quotes, and the evidence call adds pictures
    // to them. An evidence call that answers with nothing is not a statement that nothing was said.
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [scopeItem({ evidence: [{ quote: "paint this whole wall red", clipId: null, timelineMs: null }] })],
        }),
        fetchScopeItemEvidence: async () => [],
      }),
      warn: collectWarnings().warn,
    });

    expect(entry!.scope!.items[0]!.evidence.map((e) => e.quote)).toEqual(["paint this whole wall red"]);
  });

  it('PROCESSING: a walk with no scope id is answered from our own table, with NO request at all', async () => {
    // The majority state in the minutes after a walk lands — which is exactly when an estimator is watching
    // the panel, and exactly when a per-walk round trip would be pure cost.
    const fetchScopeItems = vi.fn();
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row({ scopeWalkthroughId: null })], {
      scopeReader: reader({ fetchScopeItems }),
      warn,
    });

    expect(entry!.state).toBe("processing");
    expect(entry!.scope).toBeNull();
    expect(entry!.scopeWalkthroughId).toBeNull();
    expect(fetchScopeItems).not.toHaveBeenCalled();
  });

  it('UNAVAILABLE: a TROCK Scope 5xx is "unavailable" with a null scope, never an empty one', async () => {
    // An empty `ready` scope would read as "this walk produced no line items" — a claim about the
    // estimator's site visit rather than about our failure to read the answer, and unfalsifiable from the
    // panel. `unavailable` is recoverable; a confidently empty scope is what somebody quietly acts on.
    const { warn, lines } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => {
          throw new Error(`TROCK Scope answered 503 for walkthrough ${SCOPE_ID}.`);
        },
      }),
      warn,
    });

    expect(entry!.state).toBe("unavailable");
    expect(entry!.scope).toBeNull();
    expect(lines.join("\n")).toContain("walk-msc4vvy4-m7r30urh");
  });

  it('MISSING: a TROCK Scope 404 is "missing" — the one negative claim, and TROCK Scope makes it', async () => {
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({ fetchScopeItems: async () => ({ outcome: "missing" }) }),
      warn,
    });

    expect(entry!.state).toBe("missing");
    expect(entry!.scope).toBeNull();
  });

  it('distinguishes "unavailable" from "missing" — a failure to read is not a claim of absence', async () => {
    // Conflating them is the mistake worth pinning: a panel that told an estimator their walk had vanished
    // every time TROCK Scope restarted would be worse than one that told them nothing.
    const { warn } = collectWarnings();
    const entries = await resolveGlassesWalkthroughScope([row({ id: U("1") }), row({ id: U("2") })], {
      scopeReader: reader({
        fetchScopeItems: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
      warn,
    });

    expect(entries.map((e) => e.state)).toEqual(["unavailable", "unavailable"]);
    expect(entries.map((e) => e.state)).not.toContain("missing");
  });
});

describe("resolveGlassesWalkthroughScope — a slow TROCK Scope cannot hang the deal page", () => {
  it("TIMEOUT: reports a walk whose read never answers as unavailable, bounded by the deadline", async () => {
    const { warn } = collectWarnings();
    const entries = await resolveGlassesWalkthroughScope([row()], {
      // A read that never settles at all: `fetch` has no default timeout, so without the deadline this
      // request would sit on the deal page forever.
      scopeReader: reader({ fetchScopeItems: () => new Promise(() => {}) }),
      timeoutMs: 25,
      warn,
    });

    expect(entries[0]!.state).toBe("unavailable");
    expect(entries[0]!.scope).toBeNull();
  });

  it("REGRESSION: the deadline covers the WHOLE fan-out, so N slow walks are not N deadlines", async () => {
    // A per-request ceiling multiplies by the number of walks: eight walks against a TROCK Scope that
    // accepts connections and answers none would be eight times the budget, from a rule that looks like it
    // bounds things at one. Measured rather than asserted structurally, because "it is a whole-phase
    // timeout" is exactly the property a refactor to per-request would silently drop.
    const rows = Array.from({ length: 8 }, (_, i) => row({ id: U(String(i)) }));
    const { warn } = collectWarnings();

    const startedAt = Date.now();
    const entries = await resolveGlassesWalkthroughScope(rows, {
      scopeReader: reader({ fetchScopeItems: () => new Promise(() => {}) }),
      timeoutMs: 40,
      warn,
    });
    const elapsed = Date.now() - startedAt;

    expect(entries.every((entry) => entry.state === "unavailable")).toBe(true);
    // Comfortably under 8 x 40ms even on a loaded CI box, and impossible to satisfy with a per-request
    // ceiling once the concurrency limit (6) forces a second wave.
    expect(elapsed).toBeLessThan(200);
  });

  it("ABORTS the reads it abandons rather than only releasing its own wait", async () => {
    // Stopping the WAIT without ending the REQUESTS leaves a socket per abandoned read for the life of the
    // process — and this endpoint is POLLED, so each slow render would strand another batch on top of the
    // last until the connection pool is gone. The ingest side learned this the expensive way; the same
    // shape is why the reader takes a signal at all.
    let observed: AbortSignal | undefined;
    const { warn } = collectWarnings();
    await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: (_id, signal) => {
          observed = signal;
          return new Promise(() => {});
        },
      }),
      timeoutMs: 25,
      warn,
    });

    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(true);
  });

  it("does not keep the event loop alive for a render nobody is waiting on", async () => {
    // The deadline timer is unref'd. Asserted through the happy path finishing promptly rather than by
    // reading the timer, because the failure this prevents is a process that will not exit.
    const { warn } = collectWarnings();
    const startedAt = Date.now();
    await resolveGlassesWalkthroughScope([row()], { scopeReader: reader(), warn });
    expect(Date.now() - startedAt).toBeLessThan(GLASSES_WALKTHROUGH_SCOPE_TIMEOUT_MS);
  });
});

describe("resolveGlassesWalkthroughScope — one walk failing must not fail the others", () => {
  it("REGRESSION: a mixed deal renders each walk on its own evidence", async () => {
    // The whole reason this is a per-walk state rather than a per-request outcome. Four walks, four
    // different answers, in one render — and the failures must not reach the successes.
    const rows = [
      row({ id: U("1"), walkId: "walk-ok", scopeWalkthroughId: "aaaaaaaa-1111-4222-8333-444455556666" }),
      row({ id: U("2"), walkId: "walk-boom", scopeWalkthroughId: "bbbbbbbb-1111-4222-8333-444455556666" }),
      row({ id: U("3"), walkId: "walk-gone", scopeWalkthroughId: "cccccccc-1111-4222-8333-444455556666" }),
      row({ id: U("4"), walkId: "walk-pending", scopeWalkthroughId: null }),
    ];
    const { warn } = collectWarnings();

    const entries = await resolveGlassesWalkthroughScope(rows, {
      scopeReader: reader({
        fetchScopeItems: async (scopeWalkthroughId) => {
          if (scopeWalkthroughId.startsWith("bbbb")) throw new Error("TROCK Scope answered 500.");
          if (scopeWalkthroughId.startsWith("cccc")) return { outcome: "missing" };
          return { outcome: "found", items: [scopeItem()], pipeline: "finished" };
        },
      }),
      warn,
    });

    expect(entries.map((entry) => [entry.walkId, entry.state])).toEqual([
      ["walk-ok", "ready"],
      ["walk-boom", "unavailable"],
      ["walk-gone", "missing"],
      ["walk-pending", "processing"],
    ]);
    // The successful walk keeps its items — the failures beside it changed nothing about it.
    expect(entries[0]!.scope?.items).toHaveLength(1);
    expect(entries[1]!.scope).toBeNull();
    expect(entries[2]!.scope).toBeNull();
    expect(entries[3]!.scope).toBeNull();
  });

  it("REGRESSION: a walk whose read fails does not abort the reads still in flight", async () => {
    // The failure isolation has to be structural rather than a try/catch that happens to be in the right
    // place: if a rejection escaped a worker, `Promise.all` would settle early and every walk after the
    // failing one would render as unavailable for no reason of its own.
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ id: U(String(i)), walkId: `walk-${i}`, scopeWalkthroughId: `0000000${i}-1111-4222-8333-444455556666` }),
    );
    const { warn } = collectWarnings();

    const entries = await resolveGlassesWalkthroughScope(rows, {
      scopeReader: reader({
        fetchScopeItems: async (scopeWalkthroughId) => {
          if (scopeWalkthroughId.startsWith("00000000")) throw new Error("boom");
          return { outcome: "found", items: [scopeItem()], pipeline: "finished" };
        },
      }),
      warn,
    });

    expect(entries[0]!.state).toBe("unavailable");
    expect(entries.slice(1).map((entry) => entry.state)).toEqual(["ready", "ready", "ready", "ready"]);
  });
});

describe("resolveGlassesWalkthroughScope — what TROCK Scope sends is not trusted", () => {
  it("carries an EMPTY item list through as ready, because a walk mid-pipeline has no scope yet", async () => {
    // "TROCK Scope answered and holds nothing yet" and "we could not ask" are different facts, and `state`
    // is what distinguishes them — not the length of the array.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        // FINISHED with nothing, which is the only shape that may be reported as "ready" and empty.
        fetchScopeItems: async () => ({ outcome: "found", items: [], pipeline: "finished" }),
      }),
      warn,
    });

    expect(entry!.state).toBe("ready");
    expect(entry!.scope).toEqual({ status: "ready", items: [] });
  });

  it("REGRESSION: an empty scope from an UNFINISHED pipeline is processing, not an empty result", async () => {
    // The forward publishes `scope_walkthrough_id` before it uploads a single clip, so a walk with no
    // scope rows yet is ordinary rather than exotic. Reported as "ready", the panel tells the estimator
    // TROCK Scope processed their site visit and extracted nothing — a claim about their walk that they
    // have no reason to doubt, and will not re-check, because this panel does not poll.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({ outcome: "found", items: [], pipeline: "working" }),
      }),
      warn,
    });

    expect(entry!.state).toBe("processing");
    expect(entry!.scope).toBeNull();
  });

  it("REGRESSION: a non-empty response whose items are ALL unusable is unavailable, not empty", async () => {
    // An upstream shape change drops every id, the per-item degrading filters them all out, and the
    // walk lands on ready-with-no-items — "this walk produced no line items" about a response that
    // plainly contained scope rows. The per-item degrading is for one bad field among good rows;
    // losing all of them is a different event, and it is recoverable.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [{ description: "Paint wall red" }, { description: "Replace fan" }],
        }),
      }),
      warn,
    });

    expect(entry!.state).toBe("unavailable");
    expect(entry!.scope).toBeNull();
  });

  it("REGRESSION: a FAILED extraction is not an empty result", async () => {
    // `failed` is terminal, so a set of "the pipeline has stopped" statuses counts it as finished and
    // the panel reports ready-with-no-items — "TROCK Scope processed this and found nothing". The
    // estimator has no reason to doubt that, and the scope that WAS in the narration is never bid.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({ outcome: "found", items: [], pipeline: "failed" }),
      }),
      warn,
    });

    expect(entry!.state).toBe("failed");
    expect(entry!.scope).toBeNull();
  });

  it("degrades each optional field on its own instead of dropping the item", async () => {
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [
            scopeItem({ trade: null, quantity: null, unit: null, confidence: null, description: "Replace fan" }),
          ],
        }),
      }),
      warn,
    });

    expect(entry!.scope!.items[0]).toEqual({
      id: "1f0c0a6e-2222-4333-8444-555566667777",
      workTypeCode: null,
      description: "Replace fan",
      trade: null,
      quantity: null,
      unit: null,
      confidence: null,
      locationLabel: null,
      evidence: [],
      quantitySource: null,
      status: null,
      lowVisualConfidence: false,
      hasOpenConflict: false,
    });
  });

  it("reads a numeric-string quantity, but never turns an empty string into zero", async () => {
    // `Number("")` is 0. A quantity TROCK Scope did not state, rendered as 0 SF, is a line item an
    // estimator would price at nothing — the one coercion in this mapper worth spelling out.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [
            scopeItem({ id: "aaaa1111-2222-4333-8444-555566667777", quantity: "700.5", confidence: "0.4" }),
            scopeItem({ id: "bbbb1111-2222-4333-8444-555566667777", quantity: "", confidence: Number.NaN }),
          ],
        }),
      }),
      warn,
    });

    expect(entry!.scope!.items.map((item) => [item.quantity, item.confidence])).toEqual([
      [700.5, 0.4],
      [null, null],
    ]);
  });

  it("drops only an item it cannot ADDRESS, and keeps the good ones beside it", async () => {
    // `id` is what the panel keys on, so an item without one cannot be rendered at all. Throwing instead
    // would turn one malformed row into `unavailable` for the whole walk and hide every good item with it.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [null, "not an object", { description: "no id at all" }, scopeItem()],
        }),
      }),
      warn,
    });

    expect(entry!.state).toBe("ready");
    expect(entry!.scope!.items.map((item) => item.id)).toEqual(["1f0c0a6e-2222-4333-8444-555566667777"]);
  });

  it("maps workTypeCode when TROCK Scope does send one", async () => {
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row()], {
      scopeReader: reader({
        fetchScopeItems: async () => ({
          outcome: "found",
          pipeline: "finished",
          items: [scopeItem({ workTypeCode: "PAINT-WALL" })],
        }),
      }),
      warn,
    });

    expect(entry!.scope!.items[0]!.workTypeCode).toBe("PAINT-WALL");
  });
});

describe("resolveGlassesWalkthroughScope — no TROCK Scope credential on this process", () => {
  it("reports every scope-bearing walk as unavailable without making a request", async () => {
    // TROCK_SCOPE_BASE_URL / TROCK_SCOPE_SERVICE_TOKEN are set on the CRM WORKER service and not on the
    // API. Until an operator sets them there this is the live production answer, so it has to be the
    // truthful one: not `missing` (we did not ask), and not an empty `ready` scope (the same lie in a
    // friendlier shape).
    __resetGlassesWalkthroughScopeWarningsForTest();
    const fetchScopeItems = vi.fn();
    const { warn, lines } = collectWarnings();

    const entries = await resolveGlassesWalkthroughScope([row(), row({ id: U("2"), scopeWalkthroughId: null })], {
      scopeReader: reader({ isConfigured: () => false, fetchScopeItems }),
      warn,
    });

    expect(entries.map((entry) => entry.state)).toEqual(["unavailable", "processing"]);
    expect(entries[0]!.scope).toBeNull();
    expect(fetchScopeItems).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("TROCK_SCOPE_BASE_URL");
  });

  it("says so ONCE per process, not once per poll of every open deal page", async () => {
    __resetGlassesWalkthroughScopeWarningsForTest();
    const { warn, lines } = collectWarnings();
    const deps = { scopeReader: reader({ isConfigured: () => false }), warn };

    await resolveGlassesWalkthroughScope([row()], deps);
    await resolveGlassesWalkthroughScope([row()], deps);
    await resolveGlassesWalkthroughScope([row()], deps);

    expect(lines).toHaveLength(1);
  });

  it("GUARD: a deal with no walks at all returns an empty list and asks nothing", async () => {
    const fetchScopeItems = vi.fn();
    const isConfigured = vi.fn(() => true);
    const { warn } = collectWarnings();

    expect(
      await resolveGlassesWalkthroughScope([], { scopeReader: reader({ isConfigured, fetchScopeItems }), warn }),
    ).toEqual([]);
    expect(fetchScopeItems).not.toHaveBeenCalled();
    expect(isConfigured).not.toHaveBeenCalled();
  });
});

describe("resolveGlassesWalkthroughScope — the capture census", () => {
  it("carries the stored census through whole and derives the narration shortfall from it", async () => {
    // 1,800,000 ms walk, 1,572 s of glasses audio, 1,500 s standalone: 228,000 ms with no narration behind
    // it. The census itself is passed on untouched — the counters ARE the diagnosis for whoever reads them.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row({ captureCensus: census() })], {
      scopeReader: reader(),
      warn,
    });

    expect(entry!.captureCensus).toEqual(census());
    expect(entry!.narrationShortfallMs).toBe(228_000);
  });

  it("reports null — not zero — for a walk with no census", async () => {
    // "We do not know" and "nothing was lost" are different claims, and a future warning must keep them
    // apart: an older app build that never counted is not a walk whose audio covered it.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row({ captureCensus: null })], { scopeReader: reader(), warn });

    expect(entry!.captureCensus).toBeNull();
    expect(entry!.narrationShortfallMs).toBeNull();
  });

  it("settles the shortfall from our own row even when TROCK Scope cannot be read", async () => {
    // The census is a database fact; nothing in the network phase may cost the panel it. A walk whose scope
    // read fails still says how much narration it lost — which is the more useful of the two facts when
    // the extraction is the thing that is failing.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope([row({ captureCensus: census() })], {
      scopeReader: reader({
        fetchScopeItems: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
      warn,
    });

    expect(entry!.state).toBe("unavailable");
    expect(entry!.narrationShortfallMs).toBe(228_000);
  });

  it("derives it for a PROCESSING walk too, which never reaches TROCK Scope at all", async () => {
    // The minutes after a walk lands are when an estimator is watching the panel, and a walk that is short
    // of narration is worth knowing about before its scope exists — while the crew is still on site.
    const { warn } = collectWarnings();
    const [entry] = await resolveGlassesWalkthroughScope(
      [row({ scopeWalkthroughId: null, captureCensus: census() })],
      { scopeReader: reader(), warn }
    );

    expect(entry!.state).toBe("processing");
    expect(entry!.narrationShortfallMs).toBe(228_000);
  });
});
