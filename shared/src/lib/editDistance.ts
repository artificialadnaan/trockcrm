/**
 * Levenshtein distance — THE one copy in the codebase.
 *
 * It lives in a NEUTRAL module rather than beside the responder matcher that first needed it. Two unrelated
 * consumers use it — the corrective-action responder matcher (person names) and directoryDedup's
 * similarity() ratio (company/contact names) — and having the company deduper import from a module named
 * after the responder matcher inverts the dependency: generic string maths is not owned by either caller.
 * Keeping it single-copy is what stops the two drifting into disagreeing about what counts as a typo; the
 * THRESHOLDS built on top of it are deliberately per-caller, because company names and person names do not
 * want the same tolerance.
 */
export function nameEditDistance(rawA: string, rawB: string): number {
  if (rawA === rawB) return 0;
  // CODE POINTS, not UTF-16 code units. Deleting one astral character costs TWO on a code-unit walk, so a
  // single-character difference read as distance 2 and blew past a cap of 1 — while the callers' thresholds
  // and length guards had already been converted to code points, leaving the two disagreeing about what one
  // edit is. Spreading a string iterates code points.
  const a = [...rawA];
  const b = [...rawB];
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);
  // TWO ROWS, not a full matrix. These inputs are untrusted: field_scorecards.superintendent_name / pm_name
  // are unbounded text columns and the submission parser caps the NUMBER of fields, never their length, so a
  // pasted blob reaches here. A full (a.length+1) x (b.length+1) matrix allocated one array per character
  // could exhaust the heap of a worker or backfill from a single persisted row. Two rows makes the memory
  // O(min(a,b)) — bounded by the roster NAME, which is always short — while the result stays exact.
  const [short, long] = a.length > b.length ? [b, a] : [a, b];
  let previous = Array.from({ length: short.length + 1 }, (_, i) => i);
  let current = new Array<number>(short.length + 1);
  for (let j = 1; j <= long.length; j++) {
    current[0] = j;
    for (let i = 1; i <= short.length; i++) {
      current[i] =
        short[i - 1] === long[j - 1]
          ? previous[i - 1]
          : 1 + Math.min(previous[i], current[i - 1], previous[i - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[short.length];
}
