// What the wizard does with a transcript once whisper hands one back.
//
// One rule governs this whole file: A DICTATED TRANSCRIPT IS NEVER LOST. It is the only artefact in the
// wizard that exists nowhere else — the audio is gone the moment the recorder stops, and the superintendent
// spoke it standing on a roof. So every failure below, without exception, degrades to the on-device
// sentence split rather than surfacing an error, and this function does not throw. Offline and one-bar
// LTE are the NORMAL case here, not the edge.
//
// The second rule is inherited from the reducer: what comes back is an ADDITION. `appendSection` appends
// it to whatever is already in the box (draft.ts), so a "formatted section" that replaced hand-typed text
// would destroy work silently. The port below sends the transcript and a character COUNT, never the
// section's text, so the server has nothing to rewrite even if it wanted to.
//
// Pure and injectable, like the rest of weekly-reports/: no React, no fetch, no auth. The wizard supplies
// the port.

import { formatDictationAsBullets } from "../dictation/bullets";
import { MAX_WEEKLY_REPORT_SECTION_CHARS } from "./draft";

/**
 * The one call this module makes. Rejects the way `apiFetch` rejects — an `ApiError` with `status` 0 for a
 * transport failure (offline, DNS, refused), 408 for a timeout, and the HTTP status otherwise.
 */
export type WeeklyReportDictationPort = (input: {
  transcript: string;
  existingChars: number;
}) => Promise<{ text?: unknown; source?: unknown }>;

export type WeeklyReportDictationOutcome = {
  /** The text to APPEND. "" only when there was nothing to say, or no room left in the section. */
  text: string;
  /**
   * Where the text came from. `"server"` when the server pass answered, `"local"` when this device
   * produced it — which covers being offline, the request failing, and the server itself falling back.
   */
  source: "server" | "local";
};

/**
 * Format a dictated transcript for the section it is about to be appended to.
 *
 * NEVER THROWS and never returns less than the local split would have. The server pass is a best-effort
 * improvement layered on top of a guaranteed answer, and this ordering is what makes that true:
 *
 *   1. compute the local split first, so an answer exists before anything can fail;
 *   2. ask the server, and take its text only if it is a non-empty string;
 *   3. clamp whichever text won to the room left in the section.
 *
 * The clamp is applied HERE as well as on the server because the two guard different failures. The
 * server's stops an over-length row reaching the database; this one is what the reducer would apply
 * anyway, and it keeps the outcome honest for a caller that reads `.text` before dispatching.
 */
export async function weeklyReportDictationText(
  input: {
    transcript: string;
    /** Length of the section this will be appended to. A count — the text itself never leaves the phone. */
    existingChars: number;
  },
  port: WeeklyReportDictationPort | null,
): Promise<WeeklyReportDictationOutcome> {
  const transcript = input.transcript.trim();
  if (!transcript) return { text: "", source: "local" };

  const local = formatDictationAsBullets(transcript);
  if (!port) return { text: clampToRemaining(local, input.existingChars), source: "local" };

  try {
    const response = await port({ transcript, existingChars: input.existingChars });
    const text = typeof response?.text === "string" ? response.text.trim() : "";
    // An empty or non-string `text` is treated exactly like a failed request. Answering "" would hand the
    // superintendent a silent no-op for a paragraph they just spoke — the worst outcome available here,
    // and the one a naive `response.text ?? ""` produces on any API drift.
    if (!text) return { text: clampToRemaining(local, input.existingChars), source: "local" };
    return { text: clampToRemaining(text, input.existingChars), source: "server" };
  } catch {
    // Deliberately swallowed, including a 4xx. There is no error worth showing: the local split already
    // holds every word that was said, it lands in the same editable box, and the alternative is an alert
    // over a report the user can simply carry on writing.
    return { text: clampToRemaining(local, input.existingChars), source: "local" };
  }
}

/**
 * Cap the addition so `existing + addition` cannot exceed the section ceiling.
 *
 * Mirrors `appendText` in draft.ts, which slices the JOINED string — dictation appends programmatically,
 * so a TextInput's `maxLength` never applies and this is the only thing standing between a runaway loop
 * and a submit that 400s at the end of the wizard.
 */
function clampToRemaining(text: string, existingChars: number): string {
  const remaining = Math.max(0, MAX_WEEKLY_REPORT_SECTION_CHARS - existingChars);
  if (text.length <= remaining) return text;
  return text.slice(0, remaining).trimEnd();
}
