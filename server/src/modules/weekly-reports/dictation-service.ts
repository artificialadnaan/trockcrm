// The server-side dictation pass the weekly-report design called for: a superintendent talks, whisper
// returns one unpunctuated paragraph, and this turns that paragraph into the dash bullets the report is
// written in.
//
// WHY IT LIVES ON THE SERVER RATHER THAN IN THE APP. The first cut shipped a deterministic sentence split
// in mobile/src/dictation/bullets.ts. That is a sentence splitter, not an editor: it cannot drop "um",
// join a false start back onto the sentence it interrupted, punctuate a run-on, or fix the homophones
// whisper reliably produces on a jobsite ("re bar", "sheeting"). Moving it here also means the prompt can
// be changed without a store release — `mobile/` has no OTA channel.
//
// WHAT THIS FUNCTION IS ALLOWED TO RETURN, AND WHY IT MATTERS. It returns ONLY the formatted transcript,
// as an ADDITION. It is never given the section the superintendent has already written, so there is no
// mechanism — prompt-injection, model error, or bug here — by which it could hand back a "rewritten
// section" that the client then files over hand-typed text. The client appends what comes back
// (draft.ts `appendSection`); this endpoint's contract is what makes that safe rather than merely
// customary. `existingChars` is a COUNT, not the prose: enough to enforce the ceiling, not enough to
// reproduce anything.
//
// AND WHAT IT MUST NEVER DO: invent a site fact. This text goes to a paying client over T Rock's name, so
// the prompt is a copy-editor's brief, the output is a constrained list of strings rather than free-form
// markdown, and anything the model returns that does not look like that list falls back to the split.
//
// Pure transport + prompt: it touches no database and holds no connection, so it is unit-testable with an
// injected fetch — and so the route can be mounted OUTSIDE the tenant transaction (see field-routes.ts).

import { WEEKLY_REPORT_SECTION_MAX_CHARS } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Opus 5 — the newest and most capable Claude model, which is this repo's default for a new AI feature.
 *
 * The job is small (a ~150-word transcript), so the per-call cost is fractions of a cent even at Opus
 * rates, and the thing being bought is judgement: what is a filler word here, what is a genuine second
 * sentence, which "re bar" is rebar. `effort: "low"` below is what keeps it fast enough to run while a
 * superintendent stands there holding the phone.
 *
 * Overridable per deploy (WEEKLY_REPORT_DICTATION_MODEL) so the tier can be moved without a code change.
 * Whatever it points at MUST support adaptive thinking, since this path deliberately omits the `thinking`
 * parameter — see the note in the request body.
 */
const DEFAULT_MODEL = "claude-opus-5";

/**
 * Ceiling on the composed addition, and the same number the client caps at.
 *
 * The cap exists because dictation appends PROGRAMMATICALLY: a TextInput's `maxLength` never applies to
 * text the app writes into the draft itself, so without a ceiling a runaway loop grows the section past
 * what `updateWeeklyReportContent` accepts and the whole submit 400s at the end of the wizard — long
 * after the work was done. It is a runaway guard, not a limit on anyone writing legitimate prose: 20k
 * characters is roughly eight times the longest section on the reference report.
 *
 * Enforced HERE as well as on the phone because the phone's copy is only a mirror. A build with a stale
 * or patched constant still cannot get an over-length addition out of this endpoint.
 */
const MAX_ADDITION_CHARS = WEEKLY_REPORT_SECTION_MAX_CHARS;

/**
 * Longest transcript this will pay a model to read.
 *
 * The recorder stops itself at 60 seconds (components/VoiceRecorder.tsx MAX_SECONDS), which is ~150 spoken
 * words — call it 1,000 characters. 4,000 is four times that, so no genuine dictation is ever refused, and
 * anything above it is by definition not one clip of speech. Those are formatted locally rather than
 * rejected: the superintendent still gets their text, and the endpoint cannot be turned into a way to
 * spend tokens by the field session that reaches it.
 */
const MAX_MODEL_TRANSCRIPT_CHARS = 4_000;

/** Hard cap on what the route accepts at all, matching the column the text is bound for. */
export const MAX_DICTATION_TRANSCRIPT_CHARS = WEEKLY_REPORT_SECTION_MAX_CHARS;

/** Most bullets one clip may produce. A 60-second dictation is a handful of sentences, never 200. */
const MAX_BULLETS = 60;

/**
 * Two attempts, not three, and a short socket bound.
 *
 * This one runs in the foreground: the recorder is holding the wizard busy while it waits (editor-state's
 * `voiceBusy` now spans this round trip), so a long retry ladder reads to the user as a hung app. Anything
 * that does not resolve quickly falls through to the local split, which is the same text they would have
 * got before this feature existed.
 */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 12_000;
/** Wall-clock ceiling across every attempt. Bounds the worst case the phone actually waits for. */
const TOTAL_DEADLINE_MS = 20_000;

/** Bullets are dashes, matching the reference PDF and what both renderers print. */
const BULLET_PREFIX = "- ";

export type WeeklyReportDictationInput = {
  /** The raw whisper transcript. */
  transcript: string;
  /**
   * How many characters the target section ALREADY holds. A count, never the text — see the file header.
   * Used only to size the remaining room, so the addition plus what is there cannot exceed the ceiling.
   */
  existingChars?: number;
};

export type WeeklyReportDictationResult = {
  /** The formatted addition. Always safe to APPEND; never a replacement for the section. */
  text: string;
  /** Which pass produced it, so a degraded deploy is visible in the logs rather than silent. */
  source: "model" | "local";
};

export type WeeklyReportDictationDeps = {
  fetchFn?: typeof fetch;
};

// ─── The deterministic fallback ────────────────────────────────────────────────────────────────────

/**
 * Split on sentence-ending punctuation followed by whitespace.
 *
 * The negative lookbehind spans TWO characters — a single capital letter and its period — because that is
 * what an initial looks like ("Met with R. Smith about the schedule"), and splitting there produces a
 * two-word bullet that reads as a transcription failure. Checking only the character before the split
 * position would test the period against itself and never fire.
 */
const SENTENCE_BOUNDARY = /(?<![A-Z]\.)(?<=[.!?])\s+/;

/** Already-bulleted text is left alone: the speaker (or a paste) already produced a list. */
function isAlreadyBulleted(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => /^\s*[-•*]\s/.test(line));
}

/**
 * Format a transcript as dash bullets WITHOUT a model.
 *
 * This is the same function as mobile/src/dictation/bullets.ts, deliberately duplicated: `mobile/` is a
 * non-workspace Expo app and cannot import @trock-crm/shared, so there is no third place to put it. The
 * two copies are pinned by the same fixtures on both sides (dictation-service.test.ts here,
 * dictation/__tests__/bullets.test.ts there) — if you change one, change the other and both fixture sets.
 *
 * It exists on the server for the same reason it exists on the phone: SOMETHING has to produce report
 * prose when the model pass is unavailable. Here that is a deploy with no ANTHROPIC_API_KEY, or a provider
 * outage; there it is a jobsite with no signal.
 *
 * A trailing PERIOD is dropped, because a bullet list reads worse with it and the reference report has
 * none — but `?` and `!` are kept, since those carry meaning a period does not.
 */
export function formatDictationAsBullets(transcript: string): string {
  const trimmed = transcript.trim();
  if (!trimmed) return "";
  if (isAlreadyBulleted(trimmed)) return trimmed;

  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const pieces = lines.length > 1 ? lines : trimmed.split(SENTENCE_BOUNDARY);

  const bullets = pieces
    .map((piece) => piece.trim().replace(/^[-•*]\s*/, "").replace(/[.]+$/, "").trim())
    .filter(Boolean)
    .map((piece) => `${BULLET_PREFIX}${piece}`);

  // A transcript that is only punctuation leaves nothing to bullet; hand back the original rather than an
  // empty string, so the user can see what was heard and fix it.
  return bullets.length > 0 ? bullets.join("\n") : trimmed;
}

// ─── Configuration ─────────────────────────────────────────────────────────────────────────────────

export function isWeeklyReportDictationModelConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

function resolveModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.WEEKLY_REPORT_DICTATION_MODEL?.trim() || DEFAULT_MODEL;
}

// ─── Prompt ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The brief. Written as a copy-editor's, not a writer's.
 *
 * Every rule here exists because the alternative reaches a paying client under T Rock's name. The model is
 * told, in order: you may not add anything; you may not remove anything that carries meaning; you may fix
 * only the artefacts of speech-to-text. "Say only what was said" is stated as the first rule and again as
 * the last, because it is the one that must survive a transcript that reads like an invitation to
 * elaborate ("...and obviously the usual issues with the north elevation").
 */
const SYSTEM_PROMPT = `You are copy-editing a construction superintendent's dictated weekly progress note for a commercial general contractor. The result is read by the paying client, so accuracy outranks polish.

Your ONLY job is to turn what was said into clean report bullets. Specifically:

1. NEVER add information. Do not invent or infer measurements, quantities, dates, percentages, trade names, subcontractor names, materials, locations, causes, consequences, or outcomes. If the superintendent did not say it, it does not appear. Do not add adjectives, severity judgements, or reassurance.
2. NEVER drop information that carries meaning. Names, numbers, locations and conditions are the substance of the note.
3. Split the transcript into one bullet per distinct point, in the order it was spoken.
4. Fix ONLY the artefacts of dictation: filler words ("um", "uh", "you know", "like"), false starts and self-corrections (keep the corrected version), missing punctuation and capitalisation, run-on sentences, and obvious speech-to-text mishearings of ordinary construction vocabulary (for example "re bar" -> "rebar", "sheeting" -> "sheathing" where the context is clearly the material). If you are not confident a word is a mishearing, leave it exactly as transcribed.
5. Keep the superintendent's own words and level of detail. Do not formalise their voice, do not translate trade shorthand into prose, and do not merge two points into one summary sentence.
6. Do not write a heading, a preamble, a closing line, or any commentary about the transcript.
7. If the transcript is empty, unintelligible, or contains no reportable content, return it as a single bullet exactly as transcribed rather than inventing content.

Return the bullets through the submit_report_bullets tool. Each bullet is one plain sentence or fragment WITHOUT a leading dash — the report adds those.`;

const BULLETS_TOOL = {
  name: "submit_report_bullets",
  description: "Return the dictated note as report bullets, in the order they were spoken.",
  input_schema: {
    type: "object",
    properties: {
      bullets: {
        type: "array",
        description:
          "One entry per distinct point the superintendent made, in spoken order. Plain text, no leading dash.",
        items: { type: "string" },
      },
    },
    required: ["bullets"],
    additionalProperties: false,
  },
} as const;

// ─── Transport ─────────────────────────────────────────────────────────────────────────────────────

type AnthropicResponse = {
  content?: Array<{ type: string; name?: string; input?: unknown }>;
  stop_reason?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Ask the model for bullets. Returns null for EVERY failure mode rather than throwing.
 *
 * Null is not laziness — it is the contract this whole feature rests on. The caller's answer to null is
 * the local split, which is exactly what shipped before the model pass existed. A thrown error here would
 * have to be caught somewhere, and the only thing any catch could usefully do is the same fallback; making
 * it the return type means no future caller can forget.
 */
async function requestBullets(
  transcript: string,
  fetchFn: typeof fetch,
): Promise<string[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const model = resolveModel();
  const deadlineAt = Date.now() + TOTAL_DEADLINE_MS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));
    try {
      const response = await fetchFn(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "x-api-key": apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          // Generous relative to the job (a ~150-word note in, a similar list out) because `max_tokens`
          // caps THINKING AND OUTPUT TOGETHER on Opus 5, adaptive thinking is on by default, and running
          // out of room reads here as `stop_reason: "max_tokens"` — which falls back to the split. That
          // would be a silent, permanent quality regression rather than a visible failure. Nothing is
          // billed for headroom that goes unused.
          max_tokens: 8_000,
          system: SYSTEM_PROMPT,
          // `thinking` is deliberately OMITTED, which runs ADAPTIVE on Opus 5. Explicitly disabling it is
          // the documented trigger for the model writing a tool call into its visible text instead of
          // emitting a tool_use block — which would look like a clean success and silently produce
          // nothing. `effort: "low"` is the lever that keeps this fast: the task is a copy-edit of ~150
          // words, and somebody is standing on a roof waiting for the box to fill in.
          output_config: { effort: "low" },
          // Forced tool use is what makes the response parseable AND what bounds it: the model can return
          // a list of strings or nothing, never a rewritten section, a heading, or markdown of its own.
          tools: [BULLETS_TOOL],
          tool_choice: { type: "tool", name: BULLETS_TOOL.name },
          messages: [{ role: "user", content: `Dictated note:\n\n${transcript}` }],
        }),
      });

      if (!response.ok) {
        // The body stays in the log. Nothing from the provider is echoed to the phone: the user's
        // recourse is identical either way (the local split already ran), so an error string would be
        // noise at best and request detail at worst.
        const body = await response.text().catch(() => "");
        console.warn("[weekly-report-dictation] Claude request failed", {
          status: response.status,
          attempt,
          body: body.slice(0, 500),
        });
        if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return null;
      }

      const payload = (await response.json()) as AnthropicResponse;
      // A truncated or declined response is NOT retried: an identical request truncates identically, and a
      // refusal will refuse again. Either way the local split is the answer.
      if (payload.stop_reason === "max_tokens" || payload.stop_reason === "refusal") {
        console.warn("[weekly-report-dictation] Claude returned no usable bullets", {
          stopReason: payload.stop_reason,
        });
        return null;
      }

      const toolUse = payload.content?.find(
        (block) => block.type === "tool_use" && block.name === BULLETS_TOOL.name,
      );
      const input = toolUse?.input as { bullets?: unknown } | undefined;
      if (!input || !Array.isArray(input.bullets)) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return null;
      }
      return input.bullets.filter((entry): entry is string => typeof entry === "string");
    } catch (error) {
      // Network failure, abort, or a body that would not parse. Retry once, then fall back.
      console.warn("[weekly-report-dictation] Claude request errored", {
        attempt,
        message: (error as Error)?.message ?? String(error),
      });
      if (attempt >= MAX_ATTEMPTS) return null;
      await sleep(RETRY_DELAY_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ─── Composition ───────────────────────────────────────────────────────────────────────────────────

/**
 * Turn the model's list of strings into the dash-bullet block the report is written in.
 *
 * The dashes are added HERE rather than asked for, so a model that returns "- foo" and one that returns
 * "foo" produce the same line — and an entry that arrives as a paragraph of markdown cannot smuggle a
 * heading in. Returns "" when nothing survives, which the caller reads as "use the split".
 */
function composeBullets(bullets: readonly string[]): string {
  const lines = bullets
    .slice(0, MAX_BULLETS)
    .map((bullet) => bullet.replace(/\s+/g, " ").replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean)
    .map((bullet) => `${BULLET_PREFIX}${bullet}`);
  return lines.join("\n");
}

/**
 * Cap the addition so `existing + addition` cannot exceed the section ceiling.
 *
 * Sliced rather than rejected: the superintendent has already spoken, and answering 400 at this point
 * loses the recording for the sake of a guard whose only purpose is bounding the row. `trimEnd` keeps the
 * cut from leaving a dangling space, and a slice that lands mid-word is a word the user can fix in the
 * box the text lands in.
 */
function clampToRemaining(text: string, existingChars: number): string {
  const remaining = Math.max(0, MAX_ADDITION_CHARS - existingChars);
  if (text.length <= remaining) return text;
  return text.slice(0, remaining).trimEnd();
}

function normalizeExistingChars(value: unknown): number {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new AppError(400, "existingChars must be a number");
  // Negative would MANUFACTURE room above the ceiling; a value past the ceiling simply leaves none.
  return Math.max(0, Math.floor(parsed));
}

/**
 * The whole pass: validate, format, cap.
 *
 * Never throws for a model or transport reason — those degrade to the local split. It throws only for a
 * request this server should not have been sent (a non-string transcript, or one longer than the column
 * it is bound for), because those are bugs rather than jobsite conditions.
 */
export async function formatWeeklyReportDictation(
  input: WeeklyReportDictationInput,
  deps: WeeklyReportDictationDeps = {},
): Promise<WeeklyReportDictationResult> {
  if (typeof input.transcript !== "string") throw new AppError(400, "transcript must be text");
  if (input.transcript.length > MAX_DICTATION_TRANSCRIPT_CHARS) {
    throw new AppError(400, `Dictated text is limited to ${MAX_DICTATION_TRANSCRIPT_CHARS} characters`);
  }
  const existingChars = normalizeExistingChars(input.existingChars);
  const transcript = input.transcript.trim();
  if (!transcript) return { text: "", source: "local" };

  const local = () => ({ text: clampToRemaining(formatDictationAsBullets(transcript), existingChars), source: "local" as const });

  // Above the model ceiling this is not one clip of speech; format it locally rather than pay to read it.
  if (transcript.length > MAX_MODEL_TRANSCRIPT_CHARS) return local();
  if (!isWeeklyReportDictationModelConfigured()) return local();

  const bullets = await requestBullets(transcript, deps.fetchFn ?? fetch);
  if (!bullets) return local();
  const composed = composeBullets(bullets);
  // A model that answered with an empty or all-blank list is not a reason to hand back nothing — the
  // superintendent said SOMETHING, and the split is the floor under every failure in this function.
  if (!composed) return local();
  return { text: clampToRemaining(composed, existingChars), source: "model" };
}
