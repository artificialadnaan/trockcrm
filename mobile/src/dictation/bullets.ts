// Turn a dictated paragraph into the dash bullets the weekly report is written in.
//
// WHY THIS IS DETERMINISTIC AND NOT A MODEL CALL. `whisper-1` returns one unformatted paragraph, and the
// reference report's three prose sections are lists of dash bullets — so something has to bridge the two.
// The design proposed a server-side formatting pass; this ships the deterministic half of it first,
// because a sentence split is exactly what the transcripts need ("Poured the north slab. Framing starts
// Monday.") and it costs no round trip, no quota and no new AI surface on a jobsite connection. A model
// pass remains a drop-in replacement behind this same call site if the split proves too blunt.
//
// The result lands in an EDITABLE box either way — the super fixes anything it got wrong before it moves
// on — so the failure mode of a bad split is a line the user re-joins, not a wrong report.

/** Bullets are dashes, matching the reference PDF and what the PDF renderer will print. */
const BULLET_PREFIX = "- ";

/**
 * Split on sentence-ending punctuation followed by whitespace.
 *
 * The negative lookbehind spans TWO characters — a single capital letter and its period — because that is
 * what an initial looks like ("Met with R. Smith about the schedule"), and splitting there produces a
 * two-word bullet that reads as a transcription failure. Checking only the character before the split
 * position would test the period against itself and never fire. The cost is that a sentence genuinely
 * ending in a lone capital ("Inspected level B. Framing Monday") is not split; that is rarer than an
 * initial, and the box is editable.
 */
const SENTENCE_BOUNDARY = /(?<![A-Z]\.)(?<=[.!?])\s+/;

/** Already-bulleted text is left alone: the user pasted or typed their own list. */
function isAlreadyBulleted(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => /^\s*[-•*]\s/.test(line));
}

/**
 * Format a transcript as dash bullets.
 *
 * Returns "" for empty input. Multi-line input is bulleted line by line (the speaker already broke it up);
 * a single paragraph is split into sentences. A trailing PERIOD is dropped, because a bullet list reads
 * worse with it and the reference report has none — but `?` and `!` are kept, since those carry meaning a
 * period does not ("Is the permit in?" is a question the client should see as one).
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
