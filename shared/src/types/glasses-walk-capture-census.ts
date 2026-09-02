/**
 * The CAPTURE CENSUS of one glasses walk — what the phone's recorder actually wrote, as counted by the
 * phone itself while it was recording: frames received, appended and dropped; audio buffers likewise;
 * seconds of narration that landed; how many times the audio engine had to be restarted.
 *
 * WHY THE SERVER KEEPS IT. The phone already measures all of this — it drives the completion screen and
 * the "(audio cut short)" marker in a walk's title — and then throws it away. On 2026-09-02 two walks lost
 * 3.8 min and 30 s of narration, and finding out what happened meant pulling 400 MB of video out of
 * object storage and reading packet timestamps, for a fact the phone had counted and discarded before the
 * upload even started. Filed beside the walk, the same question is one row read.
 *
 * WHY IT LIVES IN `shared/`. Three readers agree on this shape and none of them may drift from the others:
 *   - the ingest route validates it        (server/src/modules/walkthrough-capture/glasses-walkthrough-service.ts)
 *   - the column is typed by it            (shared/src/schema/tenant/glasses-walkthroughs.ts, jsonb)
 *   - the deal page's AI-walk panel reads it (client/src/hooks/use-glasses-walkthroughs.ts)
 * The phone is the fourth party and the AUTHOR: the mobile app sends exactly this on the completion call
 * (`POST /api/field/projects/:dealId/glasses-walkthroughs`, top-level `captureCensus`). Its copy of the
 * shape is in the mobile repo's walkthrough recorder, and changing either side means changing both.
 *
 * TESTIMONY, NOT A SCHEMA. Every number here is the phone's own count and the server records it as
 * received. Unknown keys are KEPT (a newer app build may count something this file does not know about
 * yet, and a diagnostic that arrives is worth more than one that was dropped for tidiness), bounded only
 * by the byte cap below. The server derives exactly one number from it — `glassesWalkNarrationShortfallMs`
 * — and stores nothing it computed.
 */

export interface GlassesWalkCaptureCensusEvent {
  /** Milliseconds into the walk, on the phone's clock. */
  atMs: number;
  /** The recorder's own label for what happened (an engine restart, a drop run starting, …). Free text by
   *  design: the recorder is on its own release cadence and this is a note in a log, not an enum. */
  kind: string;
}

export interface GlassesWalkCaptureCensus {
  /** Wall-clock length of the walk in milliseconds, from the recorder starting to it stopping. */
  walkMs: number;
  video: {
    framesReceived: number;
    framesAppended: number;
    framesDropped: number;
    /** How long the video stream had been silent when the walk ended. A large value on a long walk is the
     *  "video died a minute in and never came back" signature. */
    secondsSinceLastFrameArrived: number;
  };
  audio: {
    buffersReceived: number;
    buffersAppended: number;
    buffersDropped: number;
    /** The longest run of consecutive dropped buffers. */
    longestDropRun: number;
    /** Seconds of narration the glasses audio path actually wrote to the file that was uploaded. */
    secondsAppended: number;
    engineRestarts: number;
    /** Seconds the phone's standalone recording captured alongside the glasses stream, as the phone reports
     *  it. Counted separately because it can cover narration the glasses path lost, which is why the
     *  shortfall below takes the larger of the two. */
    standaloneSecondsRecorded: number;
    events: GlassesWalkCaptureCensusEvent[];
  };
}

/**
 * How many `audio.events` are kept. The counters above already summarise the whole walk; the events are
 * the ORDER things went wrong in, and the start of a cascade is what tells you what began it. A walk whose
 * recorder logged more than this is one whose engine was restarting in a loop, and that is exactly the
 * walk the census exists to record — so the tail is TRUNCATED rather than the completion refused. The
 * crew's media landing must never depend on how verbose the diagnostics were.
 */
export const GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS = 200;

/**
 * The ceiling on what one census may occupy once serialised, measured on what would be STORED (after the
 * event truncation above), so a verbose-but-well-formed census is trimmed, never refused. A well-formed
 * census with 200 events is under 10 KiB; the only way past this is a body that is not the contract at
 * all — an unknown key carrying a blob, an event `kind` that is an essay — and that is refused with a 400
 * like any other malformed field. This value is a deal-page read (every poll of the AI-walk panel carries
 * every walk's census), which is why it is 64 KiB and not the request body limit.
 */
export const GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES = 64 * 1024;

/** An event `kind` is a label, and the recorder's own labels are a few words long. */
export const GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENT_KIND_CHARS = 100;

/**
 * Above this much missing narration the ingest logs a warning the moment the walk lands, so ops sees a bad
 * walk without anyone opening the deal. Five seconds rather than zero because a walk's audio legitimately
 * starts a beat after its clock does; the two walks that motivated this were short by 30 s and 3.8 min.
 */
export const GLASSES_WALK_NARRATION_SHORTFALL_WARN_MS = 5_000;

export type GlassesWalkCaptureCensusValidation =
  | { ok: true; value: GlassesWalkCaptureCensus | null }
  | { ok: false; error: string };

const VIDEO_COUNTERS = [
  "framesReceived",
  "framesAppended",
  "framesDropped",
  "secondsSinceLastFrameArrived",
] as const;

const AUDIO_COUNTERS = [
  "buffersReceived",
  "buffersAppended",
  "buffersDropped",
  "longestDropRun",
  "secondsAppended",
  "engineRestarts",
  "standaloneSecondsRecorded",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The size of one census as Postgres will store it — its JSON serialisation, in UTF-8 bytes.
 *
 * Counted by hand rather than via `TextEncoder` or `Buffer`: this file is shared with the browser build
 * and compiled under a tsconfig with neither DOM nor Node globals, so the only portable byte counter is
 * the one that needs no global at all. UTF-16 code units map to UTF-8 as 1, 2 or 3 bytes, and a surrogate
 * pair to 4; `JSON.stringify` never emits a lone surrogate, so the pair branch can consume both halves.
 */
export function glassesWalkCaptureCensusBytes(census: GlassesWalkCaptureCensus): number {
  const text = JSON.stringify(census);
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Reads a set of non-negative counters off one object, or names the first one that is not.
 *
 * Non-negative and FINITE, not integer: several of these are seconds and arrive fractional, and the
 * counters that are whole in practice gain nothing from a stricter check the phone cannot fail except by
 * a bug this side has no business masking. Infinity and NaN are refused because `JSON.stringify` turns
 * both into `null`, which would store a census that reads as "the phone did not say" for a field the
 * phone very much did say something about.
 */
function readCounters<K extends string>(
  raw: Record<string, unknown>,
  keys: readonly K[],
  path: string
): { ok: true; value: Record<K, number> } | { ok: false; error: string } {
  const value = {} as Record<K, number>;
  for (const key of keys) {
    const counter = raw[key];
    if (!isNonNegativeFiniteNumber(counter)) {
      return { ok: false, error: `${path}.${key} must be a non-negative number.` };
    }
    value[key] = counter;
  }
  return { ok: true, value };
}

/**
 * Validate one capture census as the completion route received it.
 *
 * Absent and null both mean "this client does not send one" and normalise to null — every app build before
 * the census shipped, and every walk before the column existed, is exactly that. Anything else must be the
 * contract above: every counter present and a non-negative finite number, `events` an array of
 * `{ atMs, kind }`. The first field that is not is named in the error, in the same `field.path must …`
 * shape the rest of the completion validator uses, so the phone's author can read the 400 and fix it.
 *
 * What comes back is the phone's object with three things done to it: the known counters proven, the
 * events truncated to `GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS`, and the whole thing measured against
 * `GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES`. Unknown keys — at the top level, inside `video`, inside `audio`,
 * inside an event — are kept, per the module header. Only the RETAINED events are validated: an event past
 * the cap is discarded whatever it holds, and checking data that is about to be dropped can only refuse a
 * walk over a field nobody will ever read.
 */
export function validateGlassesWalkCaptureCensus(
  raw: unknown,
  field: string = "captureCensus"
): GlassesWalkCaptureCensusValidation {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isPlainObject(raw)) return { ok: false, error: `${field} must be an object.` };

  if (!isNonNegativeFiniteNumber(raw.walkMs)) {
    return { ok: false, error: `${field}.walkMs must be a non-negative number.` };
  }

  if (!isPlainObject(raw.video)) return { ok: false, error: `${field}.video must be an object.` };
  const video = readCounters(raw.video, VIDEO_COUNTERS, `${field}.video`);
  if (!video.ok) return video;

  if (!isPlainObject(raw.audio)) return { ok: false, error: `${field}.audio must be an object.` };
  const audio = readCounters(raw.audio, AUDIO_COUNTERS, `${field}.audio`);
  if (!audio.ok) return audio;

  if (!Array.isArray(raw.audio.events)) {
    return { ok: false, error: `${field}.audio.events must be an array.` };
  }
  const events: GlassesWalkCaptureCensusEvent[] = [];
  for (const [index, entry] of raw.audio.events.slice(0, GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENTS).entries()) {
    const path = `${field}.audio.events[${index}]`;
    if (!isPlainObject(entry)) return { ok: false, error: `${path} must be an object.` };
    if (!isNonNegativeFiniteNumber(entry.atMs)) {
      return { ok: false, error: `${path}.atMs must be a non-negative number.` };
    }
    if (typeof entry.kind !== "string" || entry.kind.trim().length === 0) {
      return { ok: false, error: `${path}.kind is required.` };
    }
    if (entry.kind.length > GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENT_KIND_CHARS) {
      return {
        ok: false,
        error: `${path}.kind must be at most ${GLASSES_WALK_CAPTURE_CENSUS_MAX_EVENT_KIND_CHARS} characters.`,
      };
    }
    events.push({ ...entry, atMs: entry.atMs, kind: entry.kind });
  }

  const value = {
    ...raw,
    walkMs: raw.walkMs,
    video: { ...raw.video, ...video.value },
    audio: { ...raw.audio, ...audio.value, events },
  } as GlassesWalkCaptureCensus;

  // Measured on what would be stored, not on what arrived, so the truncation above is what bounds a
  // verbose census and this cap only ever refuses a body that was never the contract.
  const bytes = glassesWalkCaptureCensusBytes(value);
  if (bytes > GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES) {
    return {
      ok: false,
      error: `${field} must be at most ${GLASSES_WALK_CAPTURE_CENSUS_MAX_BYTES} bytes when serialised (got ${bytes}).`,
    };
  }

  return { ok: true, value };
}

/**
 * How much of the walk has NO narration behind it, in milliseconds: the walk's length less the longer of
 * the two audio recordings. Zero for a walk whose audio covers it; null for a walk with no census at all.
 *
 * The larger of `secondsAppended` and `standaloneSecondsRecorded`, not their sum — they are two recordings
 * of the same minutes, and the question is whether the narration exists ANYWHERE, not how many copies of
 * it there are. Clamped at zero because audio can legitimately run a fraction past the walk clock, and a
 * negative shortfall would read as a claim about something. Rounded because the seconds arrive fractional
 * and a shortfall of 1837.4000000000001 ms is noise in a log line.
 *
 * DEFENSIVE ON THE STORED SHAPE, deliberately: the column is jsonb, which constrains nothing, and a row
 * repaired by hand — or written by a future build that renames a counter — must degrade to "unknown"
 * rather than throw inside a deal-page read that carries every other walk on the deal with it.
 */
export function glassesWalkNarrationShortfallMs(
  census: GlassesWalkCaptureCensus | null | undefined
): number | null {
  if (!census || !isPlainObject(census.audio)) return null;
  const { walkMs } = census;
  const { secondsAppended, standaloneSecondsRecorded } = census.audio;
  if (
    !isNonNegativeFiniteNumber(walkMs) ||
    !isNonNegativeFiniteNumber(secondsAppended) ||
    !isNonNegativeFiniteNumber(standaloneSecondsRecorded)
  ) {
    return null;
  }
  return Math.max(0, Math.round(walkMs - Math.max(secondsAppended, standaloneSecondsRecorded) * 1000));
}
