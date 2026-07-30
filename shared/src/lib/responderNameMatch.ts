/**
 * Resolve a TYPED responder name on a field scorecard back to the managed field-responder roster.
 *
 * Corrective-action responders normally resolve from field_scorecards.superintendent_responder_id /
 * pm_responder_id, which are set only when the submitter PICKED a roster row in the mobile app. In practice
 * almost nobody picks: of the 19 cards in office_dallas, 3 carry a superintendent pick and ZERO carry a PM
 * pick, and deal_team_members — the only other fallback — is empty office-wide. So a below-band card
 * routinely reaches nobody. This is the last-resort fallback: given the free text that WAS typed, work out
 * who on the roster was meant.
 *
 * READ THIS BEFORE LOOSENING ANYTHING. The mobile ResponderPicker deliberately refuses to name-match, and
 * says why: "a free-text entry that happens to spell a roster member is not a pick and must not silently
 * address them. Name-matching is what made the earlier attempt at this feature able to email someone the
 * user never chose." That bug has already shipped once. The two failure costs are not symmetric — a missed
 * match costs somebody a follow-up, a WRONG match emails a real person a corrective action that is not
 * theirs. So every rule below is written to fail towards "unresolved", and the caller is expected to surface
 * `ambiguous` / `unmatched` to a human rather than treat them as noise.
 *
 * The single rule the whole matcher reduces to:
 *
 *   A segment matches a roster person only if EVERY token in the segment is accounted for by a DISTINCT
 *   part of that person's name, at least one of those accountings is EXACT, and at most one is fuzzy.
 *
 * The load-bearing half of that is "every token". An unmatched token is evidence AGAINST a match, not
 * neutral: the prod value "Nick Cheaham" queried as a superintendent must resolve to nobody, because
 * Nick Cheatam is a project_manager and the only Nick among superintendents is Nick REYES. Anything that
 * falls back to "unique first name in role" emails Nick Reyes somebody else's corrective action. The
 * surname token "Cheaham" matches no superintendent surname, and that is precisely what distinguishes it
 * from "Brett/robert sampley", where the bare "Brett" segment carries no surname arguing otherwise.
 *
 * Lives in shared, not next to the server-only server/src/services/directoryDedup.ts, because BOTH the
 * server (resolving at read time) and the worker (addressing the oversight email) must answer this question
 * the same way.
 */

/** Distinguishable so a caller can require a stronger tier before auto-addressing an email. */
export type ResponderMatchConfidence = "exact" | "high";

/** The minimum a roster row needs to be matched against; callers pass their own richer rows through. */
export interface ResponderRosterEntry {
  id: string;
  name: string;
  /** 'superintendent' | 'project_manager' */
  role: string;
  isActive: boolean;
}

export interface ResponderMatch<T extends ResponderRosterEntry> {
  responder: T;
  confidence: ResponderMatchConfidence;
  /** The input segment this resolved from, verbatim, so a caller can show what it read. */
  matchedText: string;
}

export interface ResponderAmbiguity<T extends ResponderRosterEntry> {
  matchedText: string;
  /** Two or more equally-good people. NEVER auto-address these; a human picks. */
  candidates: T[];
}

/**
 * Deliberately four distinguishable outcomes without re-parsing: `matches` empty + `unmatched` empty means
 * the field was blank; `unmatched` non-empty means a segment named somebody the roster does not hold;
 * `ambiguous` non-empty means several people fit; and a partially-resolved multi-person field shows up as
 * `matches` AND (`ambiguous` | `unmatched`) both populated — which must not be reported as a clean resolve.
 */
export interface ResponderMatchResult<T extends ResponderRosterEntry> {
  matches: ResponderMatch<T>[];
  ambiguous: ResponderAmbiguity<T>[];
  unmatched: string[];
}

export interface MatchFieldRespondersInput<T extends ResponderRosterEntry> {
  /** The raw free text as typed (field_scorecards.superintendent_name / pm_name). */
  text: string | null | undefined;
  /** 'superintendent' | 'project_manager'. Candidates are filtered to this; see the role note below. */
  role: string;
  roster: readonly T[];
}

/**
 * Fuzziness gate, as an explicit distance ladder rather than a similarity ratio.
 *
 * A ratio alone is what would let "Addy" become "Adam Sherwood": distance 2 over 4 characters reads as a
 * respectable 0.5, and any threshold low enough to accept the four real spellings of Cheatam is low enough
 * to accept that too. Short strings simply do not carry enough signal, so below MIN they must match
 * exactly. Above it the cap is absolute (never a fraction), because a long surname does not earn more typos
 * than a medium one — it just survives them better.
 *
 * Calibrated against the four spellings of ONE prod person, Nick Cheatam:
 *   cheatham / cheatum / cheatem -> distance 1
 *   chatham                      -> distance 2   <- this is the case that forces LONG's cap to be 2
 * and against the pairs that must NOT collapse:
 *   addy / adam    -> distance 2 over 4 chars, below MIN, so exact-only        -> no match
 *   cheaham/reyes  -> compared at min length 5, cap 1, actual distance far above -> no match
 */
const FUZZY_MIN_TOKEN_LENGTH = 5;
const FUZZY_LONG_TOKEN_LENGTH = 7;
const FUZZY_MAX_DISTANCE_SHORT = 1;
const FUZZY_MAX_DISTANCE_LONG = 2;

/**
 * Split on / , & + ; and the word "and" — the separators that actually appear in the field. Prod holds
 * "Brett Bell/Robert Sampley", "Brett bell & Robert Sampley" and "Brett/robert sampley", so a two-person
 * field is normal and must yield two recipients, in the order typed.
 *
 * Splitting happens on the RAW text, before normalization, which is why this cannot reuse the server's
 * normalizeDirectoryName even setting aside that shared cannot import server: that helper rewrites "&" to
 * " and " and strips company suffixes. Here "&" is a DELIMITER, and a person's surname is not a suffix.
 */
// Order matters. "w/" must be consumed as a DELIMITER before the bare "/" alternative gets to it, or
// "Brett Bell w/ Robert Sampley" splits into "Brett Bell w" + "Robert Sampley": the second person resolves,
// the first is left with an orphan "w" token that fails the every-token rule, and the field SILENTLY
// half-resolves. Half-resolving is worse than not splitting at all — one real superintendent is dropped
// while the result still looks successful.
//
// A newline is a delimiter in its own right: this is free text typed on a phone, so "name\nname" is a
// perfectly ordinary way to enter two people and there is no punctuation to key off.
const SEGMENT_DELIMITERS = /\s+w\/+\s*|\s*[/&+,;]\s*|\s*[\n\r]+\s*|\s+and\s+/gi;

/**
 * Noise that carries NO identity: honorifics, and role annotations people append to the name field
 * ("Adam Sherwood (PM)", "Adam Sherwood - PM"). Stripping these removes tokens rather than loosening any
 * distance allowance, so it cannot make a wrong person reachable — it only stops a right one being missed.
 *
 * Generational suffixes (Jr / Sr / II / III) are DELIBERATELY NOT stripped. Those DO distinguish people:
 * "Brett Bell Jr" may be a different human from "Brett Bell", and guessing which of the two to email is
 * exactly the class of mistake this matcher exists to avoid. It resolves to nobody, on purpose.
 */
const IDENTITY_NEUTRAL_NOISE: RegExp[] = [
  /\([^)]*\)/g, // "(PM)", "(super)", "(Dallas)"
  /^\s*(?:mr|mrs|ms|dr|mx)\.?\s+/i, // leading honorific
  /\s+-\s*(?:pm|project\s*manager|super(?:intendent)?|supt)\.?\s*$/i, // trailing " - PM"
];

function stripIdentityNeutralNoise(segment: string): string {
  return IDENTITY_NEUTRAL_NOISE.reduce((text, pattern) => text.replace(pattern, " "), segment).trim();
}

/**
 * Levenshtein distance. THE one copy — server/src/services/directoryDedup.ts's private similarity() is a
 * ratio wrapper over this function, so the two matchers cannot drift into disagreeing about what a typo is.
 */
export function nameEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1][j - 1]
          : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

/** Case-, punctuation- and whitespace-insensitive. Keeps digits so a junk token stays a token. */
export function normalizeResponderName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The raw, trimmed person-segments of a free-text field, in the order they were typed. */
export function splitResponderSegments(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(SEGMENT_DELIMITERS)
    .map((segment) => stripIdentityNeutralNoise(segment))
    .filter((segment) => normalizeResponderName(segment).length > 0);
}

/**
 * The allowance for one token against one name part, measured on the SHORTER of the two.
 *
 * Shorter, not longer, so a stub cannot ride a long part's allowance — "bob" must not reach "robertson".
 */
function maxEditDistance(tokenLength: number, partLength: number): number {
  const length = Math.min(tokenLength, partLength);
  if (length < FUZZY_MIN_TOKEN_LENGTH) return 0;
  if (length < FUZZY_LONG_TOKEN_LENGTH) return FUZZY_MAX_DISTANCE_SHORT;
  return FUZZY_MAX_DISTANCE_LONG;
}

/**
 * How well one segment's tokens account for one person's name, or null for "not this person".
 *
 * Every branch that returns null is a safety rule, so each says which one:
 *   - no exact token at all        -> fuzz with nothing to anchor it is a guess. This is also what makes a
 *                                     BARE first name safe: one token, so it must be exactly right.
 *   - more than one fuzzy token    -> two typos in one name is a coincidence, not a spelling.
 *   - a token with no free part    -> a token nothing can account for is evidence against ("Nick Cheaham").
 *
 * More tokens than parts is a bounded early-out for that last rule rather than a rule of its own — the
 * surplus token could not have found a free part anyway — so garbage input costs one pass, not a DP table.
 *
 * "exact" is reserved for a segment that accounts for the WHOLE name exactly; a bare "Brett" that leaves
 * "Bell" unspoken is "high", because the caller may reasonably want the full-name tier before auto-sending.
 */
function scoreSegmentAgainstName(tokens: string[], parts: string[]): ResponderMatchConfidence | null {
  if (tokens.length === 0 || tokens.length > parts.length) return null;

  const consumed = parts.map(() => false);
  const unaccounted: string[] = [];
  let exactCount = 0;

  for (const token of tokens) {
    const index = parts.findIndex((part, i) => !consumed[i] && part === token);
    if (index >= 0) {
      consumed[index] = true;
      exactCount += 1;
    } else {
      unaccounted.push(token);
    }
  }

  if (exactCount === 0) return null;
  if (unaccounted.length > 1) return null;

  if (unaccounted.length === 1) {
    const token = unaccounted[0];
    const index = parts.findIndex(
      (part, i) =>
        !consumed[i] && nameEditDistance(token, part) <= maxEditDistance(token.length, part.length),
    );
    if (index < 0) return null;
    return "high";
  }

  return tokens.length === parts.length ? "exact" : "high";
}

/**
 * Resolve free text to roster people. See the module header for the one rule and why it is that strict.
 *
 * Role scoping is absolute: a project_manager can never come back from a superintendent query however well
 * the name matches, and an inactive roster row is never a candidate (a deactivated person must not be
 * emailed a corrective action — the roster row survives only so historical picks still render).
 */
export function matchFieldResponders<T extends ResponderRosterEntry>({
  text,
  role,
  roster,
}: MatchFieldRespondersInput<T>): ResponderMatchResult<T> {
  const result: ResponderMatchResult<T> = { matches: [], ambiguous: [], unmatched: [] };

  const segments = splitResponderSegments(text);
  if (segments.length === 0) return result;

  const wantedRole = role.trim().toLowerCase();
  const candidates = roster
    .filter((entry) => entry.isActive && entry.role.trim().toLowerCase() === wantedRole)
    .map((entry) => ({ entry, parts: normalizeResponderName(entry.name).split(" ") }))
    .filter((candidate) => candidate.parts[0].length > 0);

  const alreadyMatched = new Set<string>();

  for (const segment of segments) {
    const tokens = normalizeResponderName(segment).split(" ");
    const scored = candidates
      .map((candidate) => ({
        entry: candidate.entry,
        confidence: scoreSegmentAgainstName(tokens, candidate.parts),
      }))
      .filter(
        (scored): scored is { entry: T; confidence: ResponderMatchConfidence } =>
          scored.confidence !== null,
      );

    if (scored.length === 0) {
      result.unmatched.push(segment);
      continue;
    }

    // A full-name hit beats a partial one outright rather than making the segment ambiguous, so a roster
    // holding both "Nick Cheatam" and a hypothetical "Nick" does not go unresolved for "Nick Cheatam".
    const best = scored.some((s) => s.confidence === "exact") ? "exact" : "high";
    const finalists = scored.filter((s) => s.confidence === best);

    if (finalists.length > 1) {
      result.ambiguous.push({ matchedText: segment, candidates: finalists.map((s) => s.entry) });
      continue;
    }

    // One person named twice in one field ("Bell, Brett") is one recipient. Keep the first occurrence so
    // the emitted order still mirrors the order typed.
    const winner = finalists[0].entry;
    if (alreadyMatched.has(winner.id)) continue;
    alreadyMatched.add(winner.id);
    result.matches.push({ responder: winner, confidence: best, matchedText: segment });
  }

  return result;
}
