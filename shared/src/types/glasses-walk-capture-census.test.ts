import { describe, expect, it } from "vitest";
import {
  GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES,
  GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS,
  GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENT_KIND_CHARS,
  glassesWalkCaptureCensusBytes,
  glassesWalkNarrationShortfallMs,
  validateGlassesWalkCaptureCensus,
  type GlassesWalkCaptureCensus,
} from "./glasses-walk-capture-census.js";

/** The census of a walk that went badly: 30 min on the clock, 26.2 min of glasses audio, and a standalone
 *  recording that did not make up the difference. Shaped exactly as the phone sends it. */
function census(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      events: [
        { atMs: 60_000, kind: "video-stalled" },
        { atMs: 1_572_000, kind: "engine-restart" },
      ],
    },
    ...overrides,
  };
}

function ok(raw: unknown): GlassesWalkCaptureCensus {
  const result = validateGlassesWalkCaptureCensus(raw);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  if (result.value === null) throw new Error("expected a census, got null");
  return result.value;
}

function error(raw: unknown): string {
  const result = validateGlassesWalkCaptureCensus(raw);
  if (result.ok) throw new Error("expected a rejection");
  return result.error;
}

describe("validateGlassesWalkCaptureCensus", () => {
  it("accepts the contract as the phone sends it, verbatim", () => {
    const raw = census();
    expect(ok(raw)).toEqual(raw);
  });

  it("normalises absent and null to null — an older app build simply does not send one", () => {
    expect(validateGlassesWalkCaptureCensus(undefined)).toEqual({ ok: true, value: null });
    expect(validateGlassesWalkCaptureCensus(null)).toEqual({ ok: true, value: null });
  });

  it("KEEPS unknown keys at every level — testimony is recorded, not curated", () => {
    // A newer recorder counting something this side does not know about yet must land, not be dropped for
    // tidiness; that is the whole point of the column being jsonb rather than a set of columns.
    const raw = census({
      recorderBuild: "2.14.0",
      video: { ...(census().video as object), codec: "h264" },
      audio: { ...(census().audio as object), sampleRate: 48_000, events: [{ atMs: 1, kind: "x", detail: { reason: "eagain" } }] },
    });
    const value = ok(raw);
    expect(value).toEqual(raw);
    expect(value).toMatchObject({
      recorderBuild: "2.14.0",
      video: { codec: "h264" },
      audio: { sampleRate: 48_000, events: [{ atMs: 1, kind: "x", detail: { reason: "eagain" } }] },
    });
  });

  it("rejects a census that is not an object, naming the field", () => {
    expect(error("lots of frames")).toBe("captureCensus must be an object.");
    expect(error([])).toBe("captureCensus must be an object.");
    expect(error(42)).toBe("captureCensus must be an object.");
  });

  it("uses the caller's field name in every message, so a nested caller reads correctly", () => {
    const result = validateGlassesWalkCaptureCensus({ walkMs: -1 }, "body.captureCensus");
    expect(result).toEqual({ ok: false, error: "body.captureCensus.walkMs must be a non-negative number." });
  });

  it("names the FIRST counter that is missing, negative, NaN or infinite", () => {
    expect(error(census({ walkMs: undefined }))).toBe("captureCensus.walkMs must be a non-negative number.");
    expect(error(census({ walkMs: "1800000" }))).toBe("captureCensus.walkMs must be a non-negative number.");
    expect(error(census({ video: { ...(census().video as object), framesDropped: -3 } }))).toBe(
      "captureCensus.video.framesDropped must be a non-negative number."
    );
    expect(error(census({ audio: { ...(census().audio as object), secondsAppended: Number.NaN } }))).toBe(
      "captureCensus.audio.secondsAppended must be a non-negative number."
    );
    // Infinity serialises to null, which would store "the phone did not say" for a field it did say.
    expect(error(census({ audio: { ...(census().audio as object), engineRestarts: Number.POSITIVE_INFINITY } }))).toBe(
      "captureCensus.audio.engineRestarts must be a non-negative number."
    );
  });

  it("rejects a missing video or audio block", () => {
    expect(error(census({ video: undefined }))).toBe("captureCensus.video must be an object.");
    expect(error(census({ audio: null }))).toBe("captureCensus.audio must be an object.");
    expect(error(census({ audio: [] }))).toBe("captureCensus.audio must be an object.");
  });

  it("accepts zero everywhere — a walk whose recorder wrote nothing is still a fact worth filing", () => {
    const empty = census({
      walkMs: 0,
      video: { framesReceived: 0, framesAppended: 0, framesDropped: 0, secondsSinceLastFrameArrived: 0 },
      audio: {
        buffersReceived: 0,
        buffersAppended: 0,
        buffersDropped: 0,
        longestDropRun: 0,
        secondsAppended: 0,
        engineRestarts: 0,
        standaloneSecondsRecorded: 0,
        events: [],
      },
    });
    expect(ok(empty)).toEqual(empty);
  });

  it("rejects events that are not an array, and a malformed retained event by index", () => {
    expect(error(census({ audio: { ...(census().audio as object), events: "none" } }))).toBe(
      "captureCensus.audio.events must be an array."
    );
    expect(error(census({ audio: { ...(census().audio as object), events: [{ atMs: 1, kind: "ok" }, "restart"] } }))).toBe(
      "captureCensus.audio.events[1] must be an object."
    );
    expect(error(census({ audio: { ...(census().audio as object), events: [{ atMs: -5, kind: "ok" }] } }))).toBe(
      "captureCensus.audio.events[0].atMs must be a non-negative number."
    );
    expect(error(census({ audio: { ...(census().audio as object), events: [{ atMs: 5, kind: "   " }] } }))).toBe(
      "captureCensus.audio.events[0].kind is required."
    );
    expect(
      error(census({ audio: { ...(census().audio as object), events: [{ atMs: 5, kind: "k".repeat(GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENT_KIND_CHARS + 1) }] } }))
    ).toBe(`captureCensus.audio.events[0].kind must be at most ${GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENT_KIND_CHARS} characters.`);
  });

  it("TRUNCATES the event log to the cap rather than refusing the walk, keeping the earliest entries", () => {
    // An engine restarting in a loop logs thousands of events, and that is precisely the walk this census
    // exists to record — refusing the completion over the size of its diagnostics would lose the crew's
    // media to protect a log. The head is kept because the start of a cascade says what began it; the
    // counters already summarise the rest.
    const events = Array.from({ length: GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS + 50 }, (_, i) => ({
      atMs: i * 1000,
      kind: `restart-${i}`,
    }));
    const value = ok(census({ audio: { ...(census().audio as object), events } }));
    expect(value.audio.events).toHaveLength(GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS);
    expect(value.audio.events[0]).toEqual({ atMs: 0, kind: "restart-0" });
    expect(value.audio.events[value.audio.events.length - 1]).toEqual({
      atMs: (GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS - 1) * 1000,
      kind: `restart-${GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS - 1}`,
    });
  });

  it("GUARD: does not validate the events it is about to discard", () => {
    // A malformed entry past the cap is dropped either way; refusing the walk over it would fail a
    // completion on a field nobody will ever read.
    const events: unknown[] = Array.from({ length: GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS }, (_, i) => ({ atMs: i, kind: "ok" }));
    events.push("not an event");
    const value = ok(census({ audio: { ...(census().audio as object), events } }));
    expect(value.audio.events).toHaveLength(GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS);
  });

  it("stays well under the byte cap at the event cap, so a well-formed census is never refused for size", () => {
    const events = Array.from({ length: GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS }, (_, i) => ({
      atMs: i * 1000,
      kind: "k".repeat(GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENT_KIND_CHARS),
    }));
    const value = ok(census({ audio: { ...(census().audio as object), events } }));
    expect(glassesWalkCaptureCensusBytes(value)).toBeLessThan(GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES);
  });

  it("REFUSES a body over the byte cap — measured on what would be STORED, after truncation", () => {
    // Only a body that was never the contract can get here: the truncation bounds the events, so the
    // overflow has to come from an unknown key carrying a blob.
    const oversized = census({ dump: "x".repeat(GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES) });
    expect(error(oversized)).toMatch(
      new RegExp(`^captureCensus must be at most ${GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES} bytes when serialised \\(got \\d+\\)\\.$`)
    );
  });

  it("GUARD: an oversized event log alone is trimmed, not refused, even when its raw size exceeds the cap", () => {
    const events = Array.from({ length: 5_000 }, (_, i) => ({ atMs: i, kind: "engine-restart-after-eagain" }));
    const raw = census({ audio: { ...(census().audio as object), events } });
    expect(glassesWalkCaptureCensusBytes(raw as unknown as GlassesWalkCaptureCensus)).toBeGreaterThan(
      GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES
    );
    expect(ok(raw).audio.events).toHaveLength(GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS);
  });
});

describe("glassesWalkCaptureCensusBytes", () => {
  it("counts UTF-8 bytes, not UTF-16 code units, so a label in another script is measured as stored", () => {
    // "é" is 1 code unit / 2 bytes; "€" is 1 / 3; "😀" is 2 / 4. The cap is a storage bound, so it has to
    // count what Postgres stores.
    const ascii = ok(census({ audio: { ...(census().audio as object), events: [{ atMs: 1, kind: "aaaa" }] } }));
    const wide = ok(census({ audio: { ...(census().audio as object), events: [{ atMs: 1, kind: "é€😀" }] } }));
    // "aaaa" and "é€😀" are both 4 UTF-16 code units; the second is 9 bytes, the first 4.
    expect(glassesWalkCaptureCensusBytes(wide) - glassesWalkCaptureCensusBytes(ascii)).toBe(5);
  });
});

describe("glassesWalkNarrationShortfallMs", () => {
  it("is the walk length less the LONGER of the two audio recordings, in whole milliseconds", () => {
    // 30 min walk, 1572 s of glasses audio, 1500 s standalone: 1,800,000 − 1,572,000.
    expect(glassesWalkNarrationShortfallMs(ok(census()))).toBe(228_000);
  });

  it("lets the standalone recording cover what the glasses path lost", () => {
    // Two recordings of the same minutes, not two halves of them: if the phone's own microphone has the
    // narration, it is not missing.
    const covered = ok(census({ audio: { ...(census().audio as object), secondsAppended: 30, standaloneSecondsRecorded: 1_800 } }));
    expect(glassesWalkNarrationShortfallMs(covered)).toBe(0);
  });

  it("clamps at zero when audio runs a fraction past the walk clock", () => {
    const over = ok(census({ audio: { ...(census().audio as object), secondsAppended: 1_800.4 } }));
    expect(glassesWalkNarrationShortfallMs(over)).toBe(0);
  });

  it("rounds a fractional shortfall to whole milliseconds", () => {
    const fractional = ok(census({ audio: { ...(census().audio as object), secondsAppended: 1_799.9994, standaloneSecondsRecorded: 0 } }));
    expect(glassesWalkNarrationShortfallMs(fractional)).toBe(1);
  });

  it("is null when there is no census", () => {
    expect(glassesWalkNarrationShortfallMs(null)).toBeNull();
    expect(glassesWalkNarrationShortfallMs(undefined)).toBeNull();
  });

  it("is null, not a throw, for a stored row whose shape has drifted", () => {
    // jsonb constrains nothing and rows get repaired by hand. A deal-page read carries every walk on the
    // deal; one bad row must degrade to "unknown" rather than take the panel down.
    expect(glassesWalkNarrationShortfallMs({ walkMs: 5 } as unknown as GlassesWalkCaptureCensus)).toBeNull();
    expect(
      glassesWalkNarrationShortfallMs({ walkMs: 5, audio: { secondsAppended: "1" } } as unknown as GlassesWalkCaptureCensus)
    ).toBeNull();
    expect(glassesWalkNarrationShortfallMs({ walkMs: "x", audio: {} } as unknown as GlassesWalkCaptureCensus)).toBeNull();
  });
});
