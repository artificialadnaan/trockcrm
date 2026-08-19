// The server-side dictation pass, exercised through its real transport with an injected fetch.
//
// Two things this file is written to prove, because both were shipped wrong elsewhere in this feature:
//
//   • EVERY failure degrades to the local split with the transcript intact. A guard tested only for
//     refusal passes even if it refuses everything, so each fallback case is paired with a CONTROL that
//     the model path genuinely returns the model's words.
//   • The character cap is real. Its fixtures are ABSOLUTE — literal 20000/10 — never `MAX + n`, because
//     a fixture computed from the constant it tests cannot detect that constant changing.
//
// The fetch stubs answer with the shapes `fetch` actually produces: a resolved Response-like object with
// `ok`/`status`/`json()`/`text()` for an HTTP outcome, and a REJECTED promise for a transport failure.
// Stubbing a throw for something that resolves (or vice versa) is how a non-fix looked verified here once.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_DICTATION_TRANSCRIPT_CHARS,
  WEEKLY_REPORT_DICTATION_CLIENT_BUDGET_MS,
  WEEKLY_REPORT_DICTATION_TOTAL_DEADLINE_MS,
  formatDictationAsBullets,
  formatWeeklyReportDictation,
  isWeeklyReportDictationModelConfigured,
} from "./dictation-service.js";

/** A transcript as whisper actually returns one: a single unbroken paragraph. */
const TRANSCRIPT = "Poured the north slab. Balcony mock up is complete. Framing starts Monday.";
/** What the on-device/local pass makes of it — the floor under every failure below. */
const LOCAL_SPLIT =
  "- Poured the north slab\n- Balcony mock up is complete\n- Framing starts Monday";

/** Build a fetch stub that answers 200 with a tool_use carrying `bullets`. */
function stubBullets(bullets: unknown, stopReason?: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "tool_use", name: "submit_report_bullets", input: { bullets } }],
      ...(stopReason ? { stop_reason: stopReason } : {}),
    }),
    text: async () => "",
  }) as unknown as Response);
}

/** Non-2xx. `text()` is what the service reads for the log, exactly as the real Response exposes it. */
function stubStatus(status: number) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "upstream said no",
  }) as unknown as Response);
}

/** The REAL offline shape: `fetch` REJECTS. It does not resolve with `{ok:false}` and it does not return null. */
function stubNetworkFailure() {
  return vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
}

function requestBody(fetchFn: { mock: { calls: unknown[][] } }, callIndex = 0) {
  const [, init] = fetchFn.mock.calls[callIndex] as unknown as [string, { body: string }];
  return JSON.parse(init.body);
}

describe("the deadline relationship with the phone", () => {
  it("finishes with room to spare inside the client's abort, so its answer can actually be used", () => {
    // These were both 20s, which cannot work: this service's clock starts when the request ARRIVES, so an
    // answer produced just inside its budget is necessarily later than the phone's abort by however long
    // the upload took. Every near-deadline response was discarded in favour of the on-device split — while
    // the model call it had already paid for ran to completion, because nothing cancels it when the client
    // disconnects. The bug was invisible: the user gets bullets either way, just not the good ones.
    //
    // Absolute literals, not a ratio: if either budget is re-chosen this should break and be re-argued.
    expect(WEEKLY_REPORT_DICTATION_TOTAL_DEADLINE_MS).toBe(15_000);
    expect(WEEKLY_REPORT_DICTATION_CLIENT_BUDGET_MS).toBe(20_000);
    // The property that matters, stated separately from the values: at least 5s for the two network legs.
    expect(
      WEEKLY_REPORT_DICTATION_CLIENT_BUDGET_MS - WEEKLY_REPORT_DICTATION_TOTAL_DEADLINE_MS,
    ).toBeGreaterThanOrEqual(5_000);
  });
});

describe("weekly-report dictation service", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── The control: the model path actually works ────────────────────────────────────────────────

  it("returns the model's bullets, dash-prefixed, when the pass succeeds", async () => {
    // THE CONTROL for every fallback test below. Without it, a service that always fell back would pass
    // all of them — "degrades to the split" is only a claim if the non-degraded path is shown to differ.
    const fetchFn = stubBullets([
      "Poured the north slab",
      "Balcony mock-up is complete",
      "Framing starts Monday",
    ]);
    const result = await formatWeeklyReportDictation(
      { transcript: "um so we uh poured the north slab, balcony mock-up's complete, framing Monday" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.source).toBe("model");
    expect(result.text).toBe(
      "- Poured the north slab\n- Balcony mock-up is complete\n- Framing starts Monday",
    );
    // Distinguishable from the split, so "source: model" is not a label over identical output.
    expect(result.text).not.toBe(formatDictationAsBullets(TRANSCRIPT));
  });

  it("sends the newest Claude model, forced tool use, and no thinking override", async () => {
    const fetchFn = stubBullets(["Slab poured"]);
    await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    const body = requestBody(fetchFn);
    expect(body.model).toBe("claude-opus-5");
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_report_bullets" });
    expect(body.tools[0].name).toBe("submit_report_bullets");
    // Explicitly DISABLING thinking is the documented trigger for a tool call arriving as plain text, so
    // the key must be absent (which runs adaptive) rather than present-and-false.
    expect(body).not.toHaveProperty("thinking");
    // Low effort is the latency lever: somebody is holding the phone while this runs.
    expect(body.output_config).toEqual({ effort: "low" });
    expect(JSON.stringify(body.messages)).toContain(TRANSCRIPT);
  });

  it("honours WEEKLY_REPORT_DICTATION_MODEL so the tier can move without a deploy", async () => {
    vi.stubEnv("WEEKLY_REPORT_DICTATION_MODEL", "claude-sonnet-5");
    const fetchFn = stubBullets(["Slab poured"]);
    await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(requestBody(fetchFn).model).toBe("claude-sonnet-5");
  });

  it("adds the dashes itself, so a model that supplies its own cannot double them", async () => {
    const fetchFn = stubBullets(["- Slab poured", "• Framing Monday", "  City inspection  Thursday "]);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.text).toBe("- Slab poured\n- Framing Monday\n- City inspection Thursday");
  });

  // ── Append-not-replace ────────────────────────────────────────────────────────────────────────

  it("never receives the existing section, so it cannot return a rewrite of it", async () => {
    // The single most important property of this endpoint. The wizard APPENDS what comes back, so a pass
    // that returned a "corrected whole section" would silently destroy hand-typed text. It cannot: the
    // only thing about the existing section that crosses the wire is its LENGTH.
    const existing = "Typed by hand on the drive over: the crane is booked for the 14th.";
    const fetchFn = stubBullets(["Slab poured"]);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT, existingChars: existing.length },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(init.body).not.toContain("crane");
    expect(init.body).not.toContain(existing);
    // ...and the answer is an ADDITION, not a section: it carries none of the hand-typed text back.
    expect(result.text).toBe("- Slab poured");
    expect(result.text).not.toContain("crane");
  });

  // ── The cap. Absolute fixtures only ───────────────────────────────────────────────────────────

  it("caps the addition at 20000 characters however long the model's answer is", async () => {
    const fetchFn = stubBullets(["A".repeat(30_000)]);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT, existingChars: 0 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    // Literal, not MAX_SECTION_CHARS: a fixture derived from the constant it tests can never fail.
    expect(result.text.length).toBe(20000);
    expect(result.text.startsWith("- AAAA")).toBe(true);
  });

  it("does NOT truncate to the section length it was told, because that number goes stale", async () => {
    // This used to slice to `20000 - existingChars`, and it lost words. `existingChars` is true when the
    // request is sent; the box stays editable for the seconds the model takes. A superintendent who
    // deletes a paragraph while "Tidying up…" is showing has made room this number does not know about,
    // and anything cut HERE is gone before the phone's own clamp — which reads the length at the moment
    // the text lands — ever sees it. A client re-clamp cannot undo a server-side truncation.
    //
    // So the client owns remaining room and this side keeps only the absolute ceiling. Handing it a
    // nearly-full section must therefore change nothing about a short answer.
    const fetchFn = stubBullets(["A".repeat(500)]);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT, existingChars: 19_990 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.text).toBe(`- ${"A".repeat(500)}`);
  });

  it("still answers a section it was told is completely full", async () => {
    // Same rule, at the extreme that used to return "". The phone decides there is no room, and says so
    // ("That section is already full") — a decision it can only make correctly with the CURRENT length.
    // Returning "" from here would have pre-empted that with a stale one.
    const fetchFn = stubBullets(["A".repeat(500)]);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT, existingChars: 20000 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.text).toBe(`- ${"A".repeat(500)}`);
  });

  it("refuses to let a negative existingChars manufacture room above the cap", async () => {
    const fetchFn = stubBullets(["A".repeat(30_000)]);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT, existingChars: -50_000 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.text.length).toBe(20000);
  });

  it("caps the LOCAL split too, which is the path a long transcript actually takes", async () => {
    // 2,858 sentences of "Abcd." → the split adds "- " and a newline to each, so the joined block runs
    // 20,005 characters: past the ceiling, and past it by enough that the cut lands mid-bullet.
    const fetchFn = stubBullets(["unused"]);
    const result = await formatWeeklyReportDictation(
      { transcript: "Abcd. ".repeat(2_858), existingChars: 0 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.source).toBe("local");
    expect(result.text.length).toBe(20000);
    // Long past a 60-second clip, so no tokens were spent reading it.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a transcript longer than the column it is bound for", async () => {
    await expect(
      formatWeeklyReportDictation({ transcript: "x".repeat(MAX_DICTATION_TRANSCRIPT_CHARS + 1) }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a transcript that is not text", async () => {
    await expect(
      formatWeeklyReportDictation({ transcript: { text: "nope" } as unknown as string }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Every failure degrades to the split, with the transcript intact ───────────────────────────

  it("falls back to the split when no API key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(isWeeklyReportDictationModelConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    const fetchFn = stubBullets(["should not be reached"]);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to the split when the transport fails outright", async () => {
    // The REAL offline shape: fetch rejects. This is the case a stub that resolved `{ok:false}` would miss.
    const fetchFn = stubNetworkFailure();
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
    // Every spoken sentence is still there — the point of the fallback.
    expect(result.text).toContain("Poured the north slab");
    expect(result.text).toContain("Framing starts Monday");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries a 500 once, then falls back", async () => {
    const fetchFn = stubStatus(500);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400, and still falls back rather than erroring", async () => {
    const fetchFn = stubStatus(400);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back on a refusal without retrying it", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stop_reason: "refusal", content: [] }),
      text: async () => "",
    }) as unknown as Response);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back on a truncated answer rather than shipping half a section", async () => {
    const fetchFn = stubBullets(["Slab pour"], "max_tokens");
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
  });

  it("falls back when the model answers without the tool", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "Here are your bullets:" }] }),
      text: async () => "",
    }) as unknown as Response);
    const result = await formatWeeklyReportDictation(
      { transcript: TRANSCRIPT },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
  });

  it("falls back when the tool payload carries nothing usable", async () => {
    // A model that answered with an empty (or all-blank) list must not silently swallow the paragraph the
    // superintendent just spoke — "" is the single worst answer this function can give.
    for (const bullets of [[], ["", "   "], "not-an-array"]) {
      const fetchFn = stubBullets(bullets);
      const result = await formatWeeklyReportDictation(
        { transcript: TRANSCRIPT },
        { fetchFn: fetchFn as unknown as typeof fetch },
      );
      expect(result).toEqual({ text: LOCAL_SPLIT, source: "local" });
    }
  });

  it("returns nothing for an empty transcript, and never calls the model for one", async () => {
    const fetchFn = stubBullets(["should not be reached"]);
    const result = await formatWeeklyReportDictation(
      { transcript: "   \n " },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual({ text: "", source: "local" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // ── The local split, pinned to the same fixtures as its mobile twin ───────────────────────────

  it("splits a dictated paragraph the same way mobile/src/dictation/bullets.ts does", async () => {
    // These cases are the SAME contract as mobile/src/dictation/__tests__/bullets.test.ts. `mobile/` is a
    // non-workspace Expo app and cannot import shared code, so the two copies are kept in step by keeping
    // these fixtures identical. Change one, change the other.
    expect(formatDictationAsBullets(TRANSCRIPT)).toBe(LOCAL_SPLIT);
    expect(formatDictationAsBullets("Is the permit in? Waiting on the city!")).toBe(
      "- Is the permit in?\n- Waiting on the city!",
    );
    expect(formatDictationAsBullets("Slab poured")).toBe("- Slab poured");
    expect(formatDictationAsBullets("")).toBe("");
    expect(formatDictationAsBullets("   \n ")).toBe("");
    expect(formatDictationAsBullets("- Slab poured\n- Framing starts Monday")).toBe(
      "- Slab poured\n- Framing starts Monday",
    );
    expect(formatDictationAsBullets("• Slab poured\n* Framing Monday\nCity inspection Thursday")).toBe(
      "- Slab poured\n- Framing Monday\n- City inspection Thursday",
    );
    expect(formatDictationAsBullets("Met with R. Smith about the schedule.")).toBe(
      "- Met with R. Smith about the schedule",
    );
  });
});
