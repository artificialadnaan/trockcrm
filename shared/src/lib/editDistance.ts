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
export function nameEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  // TWO ROWS, not a full matrix. These inputs are untrusted: field_scorecards.superintendent_name / pm_name
  // are unbounded text columns and the submission parser caps the NUMBER of fields, never their length, so a
  // pasted blob reaches here. A full (a.length+1) x (b.length+1) matrix allocated one array per character
  // could exhaust the heap of a worker or backfill from a single persisted row. Two rows makes the memory
  // O(min(a,b)) — bounded by the roster NAME, which is always short — while the result stays exact.
  if (a.length > b.length) [a, b] = [b, a];
  let previous = Array.from({ length: a.length + 1 }, (_, i) => i);
  let current = new Array<number>(a.length + 1);
  for (let j = 1; j <= b.length; j++) {
    current[0] = j;
    for (let i = 1; i <= a.length; i++) {
      current[i] =
        a[i - 1] === b[j - 1]
          ? previous[i - 1]
          : 1 + Math.min(previous[i], current[i - 1], previous[i - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[a.length];
}
