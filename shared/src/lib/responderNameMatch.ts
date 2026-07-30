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
 * neutral. That is what keeps the prod value "Nick Cheaham" away from superintendent Nick REYES — the
 * surname token argues against a bare first-name hit — while still letting it reach the person actually
 * meant, Nick Cheatam, on "nick" exact + "cheaham"/"cheatam" at distance 1. Contrast "Brett/robert
 * sampley", where the bare "Brett" segment carries no surname arguing otherwise and so resolves.
 *
 * Note that Cheatam is a project_manager and that text sits in a card's SUPERINTENDENT field. Which field a
 * name was typed into is NOT evidence of the role that person holds, so role is a preference here rather
 * than a filter — see matchFieldResponders. The every-token rule, not the role filter, is what protects
 * identity: "cheaham" against "reyes" is far outside every threshold either way.
 *
 * Lives in shared, not next to the server-only server/src/services/directoryDedup.ts, because BOTH the
 * server (resolving at read time) and the worker (addressing the oversight email) must answer this question
 * the same way.
 */

import { nameEditDistance } from "./editDistance.js";

// Re-exported so the matcher's own callers and tests keep one import, while the implementation lives in a
// neutral module that directoryDedup can depend on without importing a responder matcher.
export { nameEditDistance };

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
  /**
   * False when this person holds the OTHER role — i.e. their name was typed into the wrong field, which
   * happens in prod ("Nick Cheaham" in a superintendent field is Nick Cheatam, a project manager).
   *
   * The person is still right. What is wrong is the SLOT: write them to the responder column for
   * `responder.role`, not for the role that was queried. recipientResolutionSql joins on
   * `fr.role = '<role>' AND fr.id = sc.<role>_responder_id`, so a PM id in the superintendent slot resolves
   * to nobody and the card silently reaches no one.
   */
  roleMatchesQuery: boolean;
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
  /**
   * 'superintendent' | 'project_manager' — the field this text came from. A PREFERENCE, not a filter: the
   * whole active roster is searched and in-role candidates merely win ties, because the field someone was
   * typed into does not reliably indicate the role they hold. Check `roleMatchesQuery` on each match.
   */
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
const SEGMENT_DELIMITERS = /\s+w\/+\s*|\s*[/&+;]\s*|\s*[\n\r]+\s*|\s+and\s+/gi;

// The comma is handled SEPARATELY from the delimiters above because it is ambiguous: it separates people
// ("Brett Bell, Robert Sampley") but it also writes ONE person surname-first ("Bell, Robert").
//
// Treated as a plain delimiter it produced two WRONG recipients from one person's name: "Bell, Robert" split
// into "Bell" -> Brett Bell (the only Bell) and "Robert" -> Robert Sampley (the only Robert), with no
// ambiguity and nothing unmatched, so a caller would email two people neither of whom was named.
//
// The disambiguator: a comma separates PEOPLE only when at least one side carries more than one token.
// Nobody writes two people as "Bell, Robert"; the surname-first form is single-token on both sides. When
// every side is a lone token the pieces are rejoined and matched as ONE segment, which then either resolves
// correctly ("Sampley, Robert" -> Robert Sampley, both tokens accounted) or resolves to nobody
// ("Bell, Robert" -> "bell robert" leaves a token unaccounted against every roster name).
const COMMA = /\s*,\s*/;

function splitOnCommaIfItSeparatesPeople(segment: string): string[] {
  const pieces = segment.split(COMMA).filter((piece) => piece.trim().length > 0);
  if (pieces.length < 2) return [segment];
  // Counted on the STRIPPED piece. Counting the raw one let an annotation masquerade as a second name
  // token: "Bell, Robert (PM)" read "Robert (PM)" as two tokens, so the comma was classed as a people
  // delimiter and the surname-first pair split back into Brett Bell + Robert Sampley — the same two clean
  // wrong recipients, reached through the annotation stripper this time. The scorer reads the stripped copy,
  // so the splitter has to reason about the same text the scorer will see.
  const tokenCount = (piece: string) =>
    normalizeResponderName(stripIdentityNeutralNoise(piece)).split(" ").length;

  // Decided PAIRWISE, walking left to right — NOT by asking whether any piece anywhere is multi-token.
  // The global test rejoined nothing in a MIXED list: "Bell, Robert, Adam Sherwood" contains a full name, so
  // every piece was split, and "Bell" -> Brett Bell plus "Robert" -> Robert Sampley reproduced the same two
  // clean wrong recipients the pairwise rule exists to prevent. A surname-first pair is two ADJACENT lone
  // tokens; a piece that already carries a full name stands alone regardless of its neighbours.
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (tokenCount(pieces[i]) === 1 && i + 1 < pieces.length && tokenCount(pieces[i + 1]) === 1) {
      out.push(`${pieces[i]} ${pieces[i + 1]}`);
      i += 1;
    } else {
      out.push(pieces[i]);
    }
  }
  return out;
}

/**
 * One person-segment: the text exactly as typed, plus the copy the scorer reads.
 *
 * Both are kept because `matchedText` and `unmatched` are contractually VERBATIM — a human triaging a
 * backfill has to see the annotation that drove the decision. Reporting the stripped copy turned
 * "Mr. Brett Bell" into "Brett Bell" and unmatched "Addy (PM)" into "Addy", hiding the very text that
 * explains the outcome.
 */
interface ResponderSegment {
  raw: string;
  stripped: string;
}

/**
 * Noise that carries NO identity: honorifics, and role annotations people append to the name field
 * ("Adam Sherwood (PM)", "Adam Sherwood - PM"). Stripping these removes tokens rather than loosening any
 * distance allowance, so it cannot make a wrong person reachable — it only stops a right one being missed.
 *
 * Generational suffixes (Jr / Sr / II / III) are DELIBERATELY NOT stripped. Those DO distinguish people:
 * "Brett Bell Jr" may be a different human from "Brett Bell", and guessing which of the two to email is
 * exactly the class of mistake this matcher exists to avoid. It resolves to nobody, on purpose.
 */
// The role words people append. Enumerated, NOT a blanket parenthetical strip: "(Jr)" is parenthetical too,
// and blanket-removing it turned "Brett Bell (Jr)" into an EXACT match for the senior Brett Bell — deleting
// the one token that distinguishes two family members, which is precisely the wrong-recipient outcome the
// unparenthesised Jr rule below exists to prevent.
const ROLE_WORD = String.raw`(?:pm|project\s*manager|super(?:intendent)?|supt|foreman)`;

const IDENTITY_NEUTRAL_NOISE: RegExp[] = [
  new RegExp(String.raw`\(\s*${ROLE_WORD}\s*\.?\s*\)`, "gi"), // "(PM)", "(super)" — role words ONLY
  /^\s*(?:mr|mrs|ms|dr|mx)\.?\s+/i, // leading honorific
  new RegExp(String.raw`\s+-\s*${ROLE_WORD}\s*\.?\s*$`, "i"), // trailing " - PM"
];

/**
 * Strip only the annotations that carry NO identity. Removing tokens can never loosen a distance allowance,
 * so this cannot make a wrong person reachable — provided what it removes is genuinely identity-free, which
 * is why the parenthetical pattern is an enumerated role list rather than `\([^)]*\)`.
 *
 * Generational suffixes (Jr / Sr / II / III) are DELIBERATELY NOT stripped, parenthesised or not. Those DO
 * distinguish people: "Brett Bell Jr" may be a different human from "Brett Bell", and guessing which of the
 * two to email is exactly the class of mistake this matcher exists to avoid. Both resolve to nobody, on
 * purpose — an unrecognised parenthetical survives as a token and then fails the every-token rule.
 */
function stripIdentityNeutralNoise(segment: string): string {
  return IDENTITY_NEUTRAL_NOISE.reduce((text, pattern) => text.replace(pattern, " "), segment).trim();
}


/**
 * Case-, punctuation- and whitespace-insensitive. Keeps digits so a junk token stays a token.
 *
 * An apostrophe is DELETED rather than turned into a space: "O'Neil" is one name part, so splitting it into
 * "o" + "neil" made the ordinary punctuationless spelling "ONeil" unable to account for either half, and the
 * real person went unmatched. Deleting collapses both spellings onto "oneil".
 *
 * A hyphen still becomes a space — "Mary-Jane" genuinely is two given names — and the joined spelling
 * "MaryJane" is handled where tokens are accounted for, by letting one token consume two ADJACENT parts.
 * Doing it there rather than here keeps this function a pure text normalizer.
 */
export function normalizeResponderName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    // FOLD diacritics, do not delete them. The [^a-z0-9] class below deletes any character it does not
    // recognise, so "josé" became "jos" — which is a DIFFERENT person's whole name. On a roster holding
    // "Jos Smith", typing "José Smith" produced an EXACT match for him; and the ordinary ASCII spelling
    // "Jose Smith" that anyone would actually type matched nobody at all. NFD splits the accent into a
    // combining mark, which is then removed, so every spelling of the name lands on "jose".
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The raw, trimmed person-segments of a free-text field, in the order they were typed. */
export function splitResponderSegments(text: string | null | undefined): string[] {
  return splitResponderSegmentPairs(text).map((segment) => segment.raw);
}

/** As above, but keeping the scorer's noise-stripped copy beside each verbatim segment. */
function splitResponderSegmentPairs(text: string | null | undefined): ResponderSegment[] {
  return (text ?? "")
    .split(SEGMENT_DELIMITERS)
    .flatMap((segment) => splitOnCommaIfItSeparatesPeople(segment))
    .map((segment) => ({ raw: segment.trim(), stripped: stripIdentityNeutralNoise(segment) }))
    .filter((segment) => normalizeResponderName(segment.stripped).length > 0);
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
 * "exact" is reserved for a segment that accounts for the WHOLE name with no fuzz; a bare "Brett" that
 * leaves "Bell" unspoken is "high", because the caller may reasonably want the full-name tier before
 * auto-sending.
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
      continue;
    }
    // A token may also account for two ADJACENT parts joined: the roster spells someone "Mary-Jane Smith"
    // (which normalizes to three parts) while people ordinarily type "MaryJane Smith". Without this the
    // joined token accounted for neither half and a real person went unmatched, contradicting the
    // punctuation-insensitive contract. Adjacent only, so it cannot staple together unrelated name parts.
    const pairIndex = parts.findIndex(
      (part, i) => !consumed[i] && !consumed[i + 1] && i + 1 < parts.length && part + parts[i + 1] === token,
    );
    if (pairIndex >= 0) {
      consumed[pairIndex] = true;
      consumed[pairIndex + 1] = true;
      exactCount += 1;
      continue;
    }
    unaccounted.push(token);
  }

  if (exactCount === 0) return null;
  if (unaccounted.length > 1) return null;

  if (unaccounted.length === 1) {
    const token = unaccounted[0];
    const index = parts.findIndex(
      (part, i) =>
        // Length difference alone is a LOWER BOUND on edit distance, so checking it first turns a pasted
        // blob into an O(1) rejection instead of an O(token x part) walk. The allowance is never above 2,
        // so anything meaningfully longer than a real surname is refused before any distance work.
        !consumed[i] &&
        Math.abs(token.length - part.length) <= maxEditDistance(token.length, part.length) &&
        nameEditDistance(token, part) <= maxEditDistance(token.length, part.length),
    );
    if (index < 0) return null;
    return "high";
  }

  // Whole name accounted for, no fuzz. Counted by CONSUMED PARTS rather than `tokens.length === parts.length`,
  // because one token may now consume two adjacent parts — "MaryJane Smith" against ["mary","jane","smith"]
  // is a complete, unfuzzy identification with 2 tokens and 3 parts.
  return consumed.every(Boolean) ? "exact" : "high";
}

/**
 * Resolve free text to roster people. See the module header for the one rule and why it is that strict.
 *
 * INACTIVE is absolute — a deactivated person is never a candidate (they must not be emailed a corrective
 * action; the roster row survives only so historical picks still render).
 *
 * ROLE is a preference. The whole active roster is searched and in-role candidates win ties; a match that
 * came from the other role is flagged `roleMatchesQuery: false`. See the note inside for why the filter was
 * removed and why doing so costs no safety.
 */
export function matchFieldResponders<T extends ResponderRosterEntry>({
  text,
  role,
  roster,
}: MatchFieldRespondersInput<T>): ResponderMatchResult<T> {
  const result: ResponderMatchResult<T> = { matches: [], ambiguous: [], unmatched: [] };

  const segments = splitResponderSegmentPairs(text);
  if (segments.length === 0) return result;

  const wantedRole = role.trim().toLowerCase();
  // ROLE is a PREFERENCE, not a filter. Which of the two name fields someone was typed into is not reliable
  // evidence of the role they hold: in prod, "Nick Cheaham" sits in a card's SUPERINTENDENT field and is Nick
  // Cheatam, a project manager. Filtering by role made that unresolvable and the card reached nobody.
  // Searching the whole roster costs no safety, because the every-token rule protects identity, not the role
  // filter: "cheaham"/"cheatam" is distance 1, while "cheaham" against superintendent Nick REYES is nowhere
  // near any threshold, so the wrong-Nick outcome the filter was credited with preventing was never reachable.
  //
  // INACTIVE rows are scored but never returned. They are kept in the pool because an EXACT hit on a
  // deactivated person is a positive identification that must BLOCK a weaker active alternative: with
  // inactive "John Smith" and active "John Smyth", filtering the inactive row out early turned an exact
  // identification of the former employee into a fuzzy match for a different, current one — and sent them
  // somebody else's corrective action.
  const candidates = roster
    .map((entry) => ({
      entry,
      parts: normalizeResponderName(entry.name).split(" "),
      inRole: entry.role.trim().toLowerCase() === wantedRole,
    }))
    .filter((candidate) => candidate.parts[0].length > 0);

  const matchIndexById = new Map<string, number>();

  for (const segment of segments) {
    const tokens = normalizeResponderName(segment.stripped).split(" ");
    const allScored = candidates
      .map((candidate) => ({
        entry: candidate.entry,
        inRole: candidate.inRole,
        confidence: scoreSegmentAgainstName(tokens, candidate.parts),
      }))
      .filter(
        (scored): scored is { entry: T; inRole: boolean; confidence: ResponderMatchConfidence } =>
          scored.confidence !== null,
      );

    const active = allScored.filter((s) => s.entry.isActive);
    const inactiveExact = allScored.some((s) => !s.entry.isActive && s.confidence === "exact");

    // An exact hit on a deactivated person wins the segment and then yields nobody: we know who was meant,
    // they must not be emailed, and no similarly-spelled active colleague may inherit their corrective
    // action. Only an equally exact ACTIVE match overrides it.
    if (inactiveExact && !active.some((s) => s.confidence === "exact")) {
      result.unmatched.push(segment.raw);
      continue;
    }

    if (active.length === 0) {
      result.unmatched.push(segment.raw);
      continue;
    }

    // CONFIDENCE FIRST, role only to break an equal-confidence tie.
    //
    // Filtering to the queried role before comparing confidence discarded a stronger identification: with PM
    // "Robert Bell" (exact) and superintendent "Robert Allen Bell" (high), a superintendent-field "Robert
    // Bell" resolved to the superintendent at HIGH while the exact PM — the person actually named — was
    // thrown away. Role cannot outrank evidence when the premise is that the field's role is unreliable.
    const best = active.some((s) => s.confidence === "exact") ? "exact" : "high";
    const atBest = active.filter((s) => s.confidence === best);
    const inRoleAtBest = atBest.filter((s) => s.inRole);

    // A BARE SINGLE TOKEN must identify exactly ONE person across the whole active roster.
    //
    // Keeping every candidate was not enough on its own: the confidence ranking could still pick one
    // outright, so a roster holding PM mononym "Nick" and superintendent "Nick Reyes" resolved a bare "Nick"
    // to the mononym on exact-beats-high, when both people plainly answer to it. For one token there is no
    // second token to arbitrate, so ANY contest is ambiguous — and role must not arbitrate it either, since
    // the slot is unreliable. This is also what stops the annotation strip manufacturing a resolvable input:
    // "Nick - PM" reduces to bare "Nick" and lands here.
    const isBareToken = tokens.length === 1;
    const finalists = isBareToken ? active : inRoleAtBest.length > 0 ? inRoleAtBest : atBest;

    if (finalists.length > 1) {
      result.ambiguous.push({ matchedText: segment.raw, candidates: finalists.map((s) => s.entry) });
      continue;
    }

    // One person named twice in one field is one recipient — but at their STRONGEST evidence, not whichever
    // segment came first. "Brett/Brett Bell" returned high while "Brett Bell/Brett" returned exact, so a
    // caller gating auto-send on the full-name tier accepted or rejected the same field purely on word order.
    const winner = finalists[0];
    const existing = matchIndexById.get(winner.entry.id);
    if (existing !== undefined) {
      const current = result.matches[existing];
      if (current.confidence !== "exact" && winner.confidence === "exact") {
        result.matches[existing] = {
          ...current,
          confidence: "exact",
          matchedText: segment.raw,
          roleMatchesQuery: winner.inRole,
        };
      }
      continue;
    }
    matchIndexById.set(winner.entry.id, result.matches.length);
    result.matches.push({
      responder: winner.entry,
      confidence: winner.confidence,
      matchedText: segment.raw,
      // False means the name was typed into the OTHER role's field. The person is still right; the slot the
      // caller must write them into is the one for `responder.role`, not the one it queried.
      roleMatchesQuery: winner.inRole,
    });
  }

  return result;
}
