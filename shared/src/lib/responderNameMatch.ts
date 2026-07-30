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
   *
   * A segment that ANNOTATES its own role ("Alex Smith (PM)") overrides this for tie-breaking purposes —
   * the annotation is deliberate, the slot is not. `roleMatchesQuery` still reports against this value.
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
// Bounds on the untrusted free text itself. Generous next to any real value — the longest in prod is
// "Brett bell & Robert Sampley" at 27 characters — and small enough that a pasted blob cannot turn one
// persisted row into meaningful CPU or heap in a worker or backfill.
const MAX_RESPONDER_TEXT_CHARS = 1_000;
const MAX_RESPONDER_SEGMENTS = 24;

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

// THE COMMA IS NOT A PERSON DELIMITER. Deliberately, after four rounds of trying to make it one.
//
// It is genuinely ambiguous: it writes one person surname-first ("Bell, Robert", "De La Cruz, Robert") and
// it could separate two ("Brett Bell, Robert Sampley"). Every syntactic rule tried to tell those apart, and
// each produced a fresh WRONG-RECIPIENT bug:
//   - split always                      -> "Bell, Robert" became Brett Bell + Robert Sampley
//   - rejoin when every piece is 1 token -> a mixed list re-split them
//   - pair two adjacent 1-token pieces   -> "De La Cruz, Robert" (multiword surname) split
//   - split when the piece after is 2+   -> "De La Cruz, Mary Jane" (compound given name) split
// The last pair is the proof it cannot be done: "De La Cruz, Mary Jane" (ONE person) and "Brett Bell,
// Robert Sampley" (TWO people) are the same shape token-for-token. Only knowing the actual humans separates
// them, and when the named person is absent from the roster — exactly when guessing is most dangerous —
// even that fails.
//
// So a comma-delimited run is ONE person-span. `normalizeResponderName` turns the comma into whitespace for
// scoring, so "Sampley, Robert" still resolves to Robert Sampley on both tokens.
//
// THE COST, stated plainly: a genuine two-person comma list ("Brett Bell, Robert Sampley") now resolves to
// NOBODY and lands in `unmatched` for a human to read. That is the designed failure direction, and it costs
// nothing on today's data — no value in the corpus uses a comma to separate people; every real multi-person
// field uses "/" or "&", which ARE unambiguous delimiters and still split. If comma-separated lists ever
// start appearing, they will surface as unmatched rather than as confidently-wrong recipients.

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
  /**
   * The role the segment ANNOTATES ("Alex Smith (PM)"), or null. Distinct from the field the text was typed
   * into, which is documented as unreliable evidence; this one the author wrote down deliberately.
   *
   * It has to survive the strip. Discarding it made the two identifications indistinguishable when the
   * annotation was the only thing separating them: with superintendent "Alex Smith" and PM "Alex Smith", a
   * superintendent-field "Alex Smith (PM)" scored both EXACT and the field-slot preference then handed the
   * card to the superintendent — the one person the text explicitly said it did not mean.
   */
  annotatedRole: string | null;
  /**
   * True when the segment named MORE THAN ONE role. That is a contradiction, not a preference, so it
   * withdraws the field's role preference as well as the annotation's — leaving a same-named pair in the two
   * roles to surface as ambiguous rather than resolving on which annotation was typed first.
   */
  roleAnnotationConflict: boolean;
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

// Kept SEPARATE from the honorific below because these two carry different information: a role annotation
// names a role and so is evidence for arbitration, while an honorific names nobody. `annotatedRoleOf` reads
// this list, and the stripper reads both — so neither can drift from the other's idea of an annotation.
const ROLE_ANNOTATIONS: RegExp[] = [
  new RegExp(String.raw`\(\s*${ROLE_WORD}\s*\.?\s*\)`, "gi"), // "(PM)", "(super)" — role words ONLY
  // Trailing punctuation after the role word must not defeat the anchor. `\.?$` tolerated only a period, so
  // "Brett Bell - PM," kept "pm" as a token, failed the every-token rule and matched NOBODY. Found by
  // COMPOSING the annotation and trailing-comma metamorphic relations — neither triggers it alone.
  new RegExp(String.raw`\s+-\s*${ROLE_WORD}\s*[.,;]*\s*$`, "i"), // trailing " - PM", " - PM," ...
];

const IDENTITY_NEUTRAL_NOISE: RegExp[] = [
  ...ROLE_ANNOTATIONS,
  /^\s*(?:mr|mrs|ms|dr|mx)\.?\s+/i, // leading honorific
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
 * Every roster role the stripped annotations named — empty when the segment carried none, and MORE THAN ONE
 * when it contradicts itself ("Alex Smith (PM) (Super)").
 *
 * Read off the SAME patterns that do the stripping, so the two can never disagree about what counts as an
 * annotation. Only the role words are consulted; an honorific names nobody.
 *
 * Exhaustive on purpose. Reading only the first annotation auto-addressed whichever role happened to be typed
 * first, while the stripper removed both — so a contradiction was invisible in the text the scorer saw AND in
 * the outcome, and the recipient came down to word order.
 */
function annotatedRolesOf(segment: string): Set<string> {
  const roles = new Set<string>();
  for (const pattern of ROLE_ANNOTATIONS) {
    // EVERY occurrence, not the first. A fresh `g`-flagged RegExp per read, because a shared global literal
    // carries `lastIndex` between calls and would make the result depend on how many segments had been
    // scanned before this one.
    for (const match of segment.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
      const word = normalizeResponderName(match[0]).replace(/\s+/g, "");
      if (/^(?:pm|projectmanager)$/.test(word)) roles.add("project_manager");
      else if (/^(?:super|superintendent|supt|foreman)$/.test(word)) roles.add("superintendent");
    }
  }
  return roles;
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
  return foldNameLetters(value)
    // Anything that is still a LETTER survives. An ASCII-only class deleted every letter the fold could not
    // reach — and the transliteration map can only ever cover the letters someone thought of. Azerbaijani
    // "Əli" (U+0259) is outside it, so "Əli Smith" became "li smith": an EXACT match for an unrelated
    // roster member named Li Smith. Preserving the letter makes the worst case a MISSED match, which is the
    // side of the trade this matcher is supposed to fail towards.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Letters that NFD does NOT decompose, because their diacritic is a stroke or the glyph is a ligature rather
 * than a base letter plus a combining mark. Without an explicit map the ASCII-only class below deletes them
 * outright, which is the same wrong-recipient bug the NFD fold was added to close: "Đan Nguyen" collapsed to
 * "an nguyen" and became an EXACT match for a distinct active responder named An Nguyen, and the ASCII
 * spelling "Soren Smith" could not reach roster entry "Søren Smith".
 */
const NON_DECOMPOSING_LETTERS: Record<string, string> = {
  đ: "d", ð: "d", ø: "o", ł: "l", ħ: "h", ŧ: "t", ŋ: "n", ı: "i", ĸ: "k",
  æ: "ae", œ: "oe", ß: "ss", þ: "th",
};

/**
 * Case-fold, fold diacritics, and drop apostrophes — WITHOUT collapsing the remaining punctuation, so a
 * caller can still see where a hyphen was. `normalizeResponderName` finishes the job for plain comparison;
 * `splitRosterNameParts` needs the punctuation intact to know which boundaries a join may cross.
 */
function foldNameLetters(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    // NFD splits an accent into a base letter plus a combining mark, which the next replace removes, so every
    // spelling of the name lands on the same ASCII base. Deleting the accented character instead turned
    // "josé" into "jos" — a different person's whole name.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/[\u00df-\u0180]/g, (ch) => NON_DECOMPOSING_LETTERS[ch] ?? ch);
}

/**
 * A roster name split into comparable parts, remembering which boundaries were created by removing
 * IDENTITY-INTERNAL punctuation.
 *
 * `joinableWithNext[i]` is true only when part i and part i+1 came from the same whitespace-delimited word —
 * i.e. a hyphen stood between them. Allowing a token to span any adjacent pair was a wrong-recipient bug:
 * bare "Annabell" consumed both parts of "Ann Abell" for an EXACT match, and "MarySmith" did the same to
 * "Mary Smith". A space between two names is a real boundary; a hyphen inside one is not.
 */
interface RosterNameParts {
  parts: string[];
  joinableWithNext: boolean[];
  /**
   * True for a generational suffix — the part that says WHICH of two same-named people this is.
   *
   * Typed suffixes were already respected ("Brett Bell Jr" does not reach roster "Brett Bell"), but the
   * mirror was not: with only "Brett Bell Jr" on the roster, input "Brett Bell" consumed both base parts,
   * left "jr" unused and resolved the junior at `high` — so a card meant for an absent senior addressed his
   * son. A suffix on the ROSTER name is required, not an optional middle name.
   */
  identitySuffix: boolean[];
}

// Not "v": a lone V is far likelier to be an initial than a fifth-generation suffix, and treating it as
// identity-bearing would block ordinary names for no real gain.
//
// DELIBERATELY NOT CANONICALIZED across spellings. "Junior" does not reach roster "Jr", and that is a MISSED
// match — the safe side of this matcher's asymmetry, costing somebody a follow-up rather than sending a real
// person a corrective action that is not theirs. Canonicalizing would LOOSEN matching, which is the direction
// every wrong-recipient defect in this file has come from, and it buys nothing measurable: a census of prod
// found 0 of 16 responders and 0 of 19 typed name fields carrying any generational suffix at all. Revisit if
// that ever stops being true, and add the position-awareness it needs first — "Junior" is also a given name,
// which is why identitySuffix already excludes index 0.
const GENERATIONAL_SUFFIXES = new Set([
  "jr", "jnr", "junior", "sr", "snr", "senior", "ii", "iii", "iv",
]);

function splitRosterNameParts(name: string): RosterNameParts {
  const parts: string[] = [];
  const joinableWithNext: boolean[] = [];
  for (const word of foldNameLetters(name).split(/\s+/).filter(Boolean)) {
    const pieces = word.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    pieces.forEach((piece, index) => {
      parts.push(piece);
      // True for every boundary INSIDE this word; false at the word's last piece, where the next boundary is
      // whitespace.
      joinableWithNext.push(index < pieces.length - 1);
    });
  }
  // Never the FIRST part: a person whose given name is "Ivy" or similar must not have it read as a suffix.
  const identitySuffix = parts.map((part, i) => i > 0 && GENERATIONAL_SUFFIXES.has(part));
  return { parts, joinableWithNext, identitySuffix };
}

/** The raw, trimmed person-segments of a free-text field, in the order they were typed. */
export function splitResponderSegments(text: string | null | undefined): string[] {
  return splitResponderSegmentPairs(text).map((segment) => segment.raw);
}

/** As above, but keeping the scorer's noise-stripped copy beside each verbatim segment. */
function splitResponderSegmentPairs(text: string | null | undefined): ResponderSegment[] {
  // A name field naming more than this many people is not a name field. The cap exists because the input is
  // untrusted — superintendent_name / pm_name are unbounded text columns and the submission parser caps the
  // NUMBER of fields, never their length — so a persisted value of "x/" repeated a few hundred thousand
  // times would otherwise materialise that many segments and score each against every roster row.
  //
  // Refusing the whole field, rather than parsing the first N, is deliberate: a truncated read of a name
  // list is a silent half-answer, and half-answers are what this matcher exists to eliminate. The single
  // unmatched entry is EXCERPTED rather than verbatim — the one place that contract yields, because echoing
  // the blob back is the same resource problem one layer up.
  const raw = text ?? "";
  if (raw.length > MAX_RESPONDER_TEXT_CHARS) {
    return [
      { raw: `${raw.slice(0, 120).trim()}… (${raw.length} characters — not parsed as names)`, stripped: "", annotatedRole: null, roleAnnotationConflict: false },
    ];
  }
  const segments = raw
    .split(SEGMENT_DELIMITERS)
    // The WHOLE segment is the reported span, so a leading or trailing annotation ("(PM), Bell, Robert",
    // "Sampley, Robert, (PM)") stays visible to whoever triages it instead of being sliced away.
    .map((segment) => ({
      raw: segment.trim(),
      stripped: stripIdentityNeutralNoise(segment),
      ...((roles) => ({
        annotatedRole: roles.size === 1 ? [...roles][0] : null,
        roleAnnotationConflict: roles.size > 1,
      }))(annotatedRolesOf(segment)),
    }))
    .filter((segment) => normalizeResponderName(segment.stripped).length > 0);
  if (segments.length > MAX_RESPONDER_SEGMENTS) {
    return [
      { raw: `${raw.slice(0, 120).trim()}… (${segments.length} segments — not parsed as names)`, stripped: "", annotatedRole: null, roleAnnotationConflict: false },
    ];
  }
  return segments;
}

/**
 * The allowance for one token against one name part, measured on the SHORTER of the two.
 *
 * Shorter, not longer, so a stub cannot ride a long part's allowance — "bob" must not reach "robertson".
 */
/** Characters, not UTF-16 code units — see the two call sites for what counting units let through. */
function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function maxEditDistance(tokenLength: number, partLength: number): number {
  // Callers pass CODE POINT counts, not `.length`. The anchor rule was fixed to count code points and this
  // ladder was not, so an astral surname of three characters measured as six and cleared the five-character
  // fuzzy floor that exists to keep short strings exact-only.
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
interface SegmentScore {
  confidence: ResponderMatchConfidence;
  /**
   * Edit distance of the single fuzzy accounting, or 0 when every token matched exactly.
   *
   * `high` is a COARSE tier: two candidates in it are not necessarily equally good. Discarding this let the
   * role preference pick the WEAKER spelling — PM "John Cheatam" (distance 1) lost to superintendent "John
   * Chattam" (distance 2) for input "John Cheatham", purely because the text sat in a superintendent field,
   * which is the one thing this matcher treats as unreliable. Role is documented as breaking a TIE; without
   * this number the code could not tell a tie from a difference.
   */
  fuzzDistance: number;
  /**
   * Roster name parts the segment never spoke — the middle name in "John Smith" against "John Allen Smith".
   *
   * A SECOND, independent axis, because incompleteness is not a spelling difference and collapsing the two
   * onto one number let an omission outrank a typo: partial matches were scored `fuzzDistance: 0`, so for
   * input "John Smith" the cross-role "John Allen Smith" (nothing misspelled, one name unspoken) beat the
   * in-role "John Smyth" (whole name spoken, one letter out) and was auto-addressed — role and ambiguity
   * never got a look. Neither reading is better evidence than the other, and `narrowToBestEvidence` keeps
   * both so the tie is broken where ties belong.
   */
  unaccountedParts: number;
}

/**
 * The candidates no rival strictly beats, on BOTH spelling distance and completeness.
 *
 * Strictly: a candidate is dropped only when some rival is at least as good on both axes and better on one.
 * Two candidates that each win an axis are genuinely incomparable and both survive, to be settled by role or
 * reported as ambiguous. A single scalar ordering here is what let an omitted name part masquerade as a
 * perfect spelling; see `unaccountedParts`.
 */
function narrowToBestEvidence<T extends { fuzz: number; incomplete: number }>(scored: T[]): T[] {
  return scored.filter(
    (candidate) =>
      !scored.some(
        (rival) =>
          rival.fuzz <= candidate.fuzz &&
          rival.incomplete <= candidate.incomplete &&
          (rival.fuzz < candidate.fuzz || rival.incomplete < candidate.incomplete),
      ),
  );
}

function scoreSegmentAgainstName(
  tokens: string[],
  { parts, joinableWithNext, identitySuffix }: RosterNameParts,
): SegmentScore | null {
  if (tokens.length === 0 || tokens.length > parts.length) return null;

  const consumed = parts.map(() => false);
  const unaccounted: string[] = [];
  // Whether ANY exact accounting was made on identity-bearing text: a part (or punctuation-joined run) that
  // is at least two characters and is not a generational suffix. See the guard below for why counting exact
  // accountings was not enough.
  let hasMeaningfulAnchor = false;

  /**
   * Indices of the punctuation-linked run starting at `start` whose concatenation is exactly `token`, or
   * null. Walks the WHOLE run rather than a fixed pair: the roster may spell someone "Mary-Jane-Lou Smith"
   * (three linked parts) while people type "MaryJaneLou Smith", and stopping at two left that asymmetric
   * against the input-side collapse, which already joins a run of any length.
   */
  const joinedRun = (start: number, token: string): number[] | null => {
    let joined = "";
    const indices: number[] = [];
    for (let i = start; i < parts.length; i++) {
      if (consumed[i]) return null;
      joined += parts[i];
      indices.push(i);
      if (joined === token) return indices;
      if (joined.length >= token.length) return null;
      if (!joinableWithNext[i]) return null;
    }
    return null;
  };

  const noteAnchor = (indices: number[]) => {
    const text = indices.map((i) => parts[i]).join("");
    // A single character is not identity evidence, and neither is a bare generational suffix: "Q" selected
    // the middle initial of "John Q Smith", and "Jr" selected the sole "Brett Bell Jr", each returning a
    // person the field never actually named.
    //
    // Measured in CODE POINTS, not `.length`. A UTF-16 code-unit count reads any astral-plane letter as two
    // characters, so a single styled or non-Latin glyph slipped past a guard whose whole point is "one
    // character is not enough" — while the visually identical ASCII letter was correctly refused.
    if (codePointLength(text) >= 2 && !indices.some((i) => identitySuffix[i])) hasMeaningfulAnchor = true;
  };

  for (const token of tokens) {
    const index = parts.findIndex((part, i) => !consumed[i] && part === token);
    if (index >= 0) {
      consumed[index] = true;
      noteAnchor([index]);
      continue;
    }
    let run: number[] | null = null;
    for (let i = 0; i < parts.length && run === null; i++) {
      if (!consumed[i] && joinableWithNext[i]) run = joinedRun(i, token);
    }
    if (run) {
      run.forEach((i) => (consumed[i] = true));
      noteAnchor(run);
      continue;
    }
    unaccounted.push(token);
  }

  // Fuzz needs a real anchor to hang off. Counting exact accountings let a one-character initial or a
  // generational suffix serve as that anchor: "Q Smyth" resolved "John Q Smith" with the identifying first
  // name unspoken, because "q" was exact and "smyth" fuzzily consumed "smith".
  if (!hasMeaningfulAnchor) return null;
  if (unaccounted.length > 1) return null;

  // Checked BEFORE either return. Placing it only on the unfuzzed path meant one typo in the base name
  // bypassed it entirely — "John Smyth" resolved roster "John Smith Jr", suffix never examined.
  const suffixUnspoken = () => parts.some((_, i) => identitySuffix[i] && !consumed[i]);
  const countUnaccounted = () => consumed.filter((taken) => !taken).length;

  if (unaccounted.length === 1) {
    const token = unaccounted[0];
    // The CLOSEST eligible part, not the first one that clears the threshold.
    //
    // `findIndex` recorded whichever unconsumed part happened to come first, so the distance carried into
    // arbitration could be larger than the real minimum — a roster row spelling "MacDonald McDonald" pinned
    // the distance-2 "MacDonald" and never saw its own distance-1 "McDonald", which then tied a farther
    // spelling elsewhere and let role pick the wrong person. That defeats the ranking added to stop exactly
    // this, so the distance has to be the best one available, not the first one found.
    //
    // A punctuation-linked RUN is one such unit, exactly as it is on the exact path above. Considering only
    // single parts made the fuzz asymmetric: roster "MaryJane Smith" accepted input "Mary-Jone Smith"
    // (the input collapses), but the mirrored roster "Mary-Jane Smith" rejected "MaryJone Smith", because
    // nothing could fuzzily account for a token spanning two hyphen-joined parts. One permitted typo must
    // not decide which of two equivalent spellings the roster happens to use.
    let bestIndices: number[] = [];
    let bestDistance = Number.POSITIVE_INFINITY;
    const consider = (indices: number[]) => {
      const text = indices.map((i) => parts[i]).join("");
      // Length difference alone is a LOWER BOUND on edit distance, so checking it first turns a pasted blob
      // into an O(1) rejection instead of an O(token x part) walk. Measured in code points for the same
      // reason the anchor is: `.length` reads one astral character as two.
      const allowance = maxEditDistance(codePointLength(token), codePointLength(text));
      if (Math.abs(codePointLength(token) - codePointLength(text)) > allowance) return;
      const distance = nameEditDistance(token, text);
      if (distance <= allowance && distance < bestDistance) {
        bestDistance = distance;
        bestIndices = indices;
      }
    };
    for (let i = 0; i < parts.length && bestDistance > 0; i++) {
      if (consumed[i]) continue;
      consider([i]);
      // Runs only ever cross boundaries a hyphen made. A space is a real boundary, which is what keeps bare
      // "Annabell" from consuming both parts of "Ann Abell".
      const run = [i];
      for (let j = i; joinableWithNext[j] && j + 1 < parts.length && !consumed[j + 1]; j++) {
        run.push(j + 1);
        consider([...run]);
      }
    }
    if (bestIndices.length === 0) return null;
    bestIndices.forEach((i) => (consumed[i] = true));
    if (suffixUnspoken()) return null;
    return { confidence: "high", fuzzDistance: bestDistance, unaccountedParts: countUnaccounted() };
  }

  // A generational suffix left unspoken rejects the match outright. It is not an optional middle name: it
  // is the part that distinguishes two same-named people, so "Brett Bell" must not resolve a roster holding
  // only "Brett Bell Jr".
  if (suffixUnspoken()) return null;

  // Whole name accounted for, no fuzz. Counted by CONSUMED PARTS rather than `tokens.length === parts.length`,
  // because one token may consume a whole punctuation-linked run — "MaryJane Smith" against
  // ["mary","jane","smith"] is a complete, unfuzzy identification with 2 tokens and 3 parts.
  return {
    confidence: consumed.every(Boolean) ? "exact" : "high",
    fuzzDistance: 0,
    unaccountedParts: countUnaccounted(),
  };
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
      nameParts: splitRosterNameParts(entry.name),
      roleKey: entry.role.trim().toLowerCase(),
    }))
    .filter((candidate) => candidate.nameParts.parts.length > 0);

  const matchIndexById = new Map<string, number>();

  for (const segment of segments) {
    // An explicit "(PM)" outranks the field the text sits in. The slot is documented as unreliable evidence —
    // that is the whole reason role is a preference — whereas an annotation is a deliberate statement by the
    // person filling the card in, and is the only thing that can separate two same-named people in different
    // roles.
    // A CONTRADICTION withdraws the preference rather than falling back to the slot. Falling back would let
    // "Alex Smith (PM) (Super)" resolve to the superintendent purely because the text sat in that field —
    // silently picking one of the two roles the segment itself could not choose between.
    const effectiveRole = segment.roleAnnotationConflict ? null : (segment.annotatedRole ?? wantedRole);
    const tokens = normalizeResponderName(segment.stripped).split(" ");
    // Punctuation-insensitivity has to be SYMMETRIC. The roster side already lets one token cover two
    // hyphen-joined parts ("MaryJane" -> "Mary-Jane"); without the mirror, the reverse spelling failed —
    // roster "DeAngelo Smith" against input "De-Angelo Smith" produced three tokens for two parts and was
    // rejected outright. This collapses runs of punctuation-adjacent INPUT tokens, and is only ever tried as
    // an ALTERNATIVE reading, so it can add a match but never change one that already succeeded.
    const inputParts = splitRosterNameParts(segment.stripped);
    const collapsed: string[] = [];
    for (let i = 0; i < inputParts.parts.length; i++) {
      let joined = inputParts.parts[i];
      while (inputParts.joinableWithNext[i] && i + 1 < inputParts.parts.length) {
        joined += inputParts.parts[i + 1];
        i += 1;
      }
      collapsed.push(joined);
    }
    const tokenReadings =
      collapsed.length > 0 && collapsed.join(" ") !== tokens.join(" ") ? [tokens, collapsed] : [tokens];
    const allScored = candidates
      .map((candidate) => ({
        entry: candidate.entry,
        // Measured against the role the segment ANNOTATED when it carried one, falling back to the field it
        // was typed into. `roleMatchesQuery` below still reports the QUERIED role — that is what tells a
        // caller which column to write — so the two must not be conflated.
        inRole: effectiveRole !== null && candidate.roleKey === effectiveRole,
        roleMatchesQuery: candidate.roleKey === wantedRole,
        // Best over the readings: the plain tokens, and the punctuation-collapsed variant.
        score: tokenReadings.reduce<SegmentScore | null>((best, reading) => {
          const scored = scoreSegmentAgainstName(reading, candidate.nameParts);
          if (!scored) return best;
          if (!best) return scored;
          if (scored.confidence === "exact" && best.confidence !== "exact") return scored;
          if (best.confidence === "exact" && scored.confidence !== "exact") return best;
          return scored.fuzzDistance < best.fuzzDistance ? scored : best;
        }, null),
      }))
      .filter(
        (scored): scored is { entry: T; inRole: boolean; roleMatchesQuery: boolean; score: SegmentScore } =>
          scored.score !== null,
      )
      .map((scored) => ({
        ...scored,
        confidence: scored.score.confidence,
        fuzz: scored.score.fuzzDistance,
        incomplete: scored.score.unaccountedParts,
      }));

    if (allScored.length === 0) {
      result.unmatched.push(segment.raw);
      continue;
    }

    // Two explicit branches, because a bare token and a full name are arbitrated on different evidence.
    let winner: (typeof allScored)[number];

    // A punctuation-collapsed reading can be bare even when the plain split is not: "Mary-Jane" splits to
    // two tokens but reads as the single name "MaryJane", and routing that through full-name arbitration let
    // it resolve superintendent "Mary-Jane Smith" outright while PM "MaryJane Jones" — who answers to exactly
    // the same bare name — was passed over. If ANY successful reading is one token, the input can be a bare
    // name, and bare names are settled by roster-wide uniqueness.
    if (tokenReadings.some((reading) => reading.length === 1)) {
      // A BARE SINGLE TOKEN must identify exactly ONE person on the roster — active or not, and at ANY
      // confidence tier. Confidence cannot arbitrate here: with a PM mononym "Nick" (exact) beside
      // superintendent "Nick Reyes" (high), ranking picked the mononym outright when both people plainly
      // answer to the token. Neither can role, since the slot is unreliable. Inactive people count too: a
      // lone token cannot say WHICH person who answers to it was meant, and narrowing to the active ones
      // handed a former employee's corrective action to a current colleague.
      //
      // This is also what stops the annotation strip manufacturing a resolvable input: "Nick - PM" reduces
      // to a bare "Nick" and lands here.
      // NOTE: a bare one-character token, or a bare generational suffix, is already rejected by the
      // meaningful-anchor rule in scoreSegmentAgainstName — which applies to EVERY segment, not just bare
      // ones, and so also covers "Q Smyth". A second guard here would be a duplicate of that property.
      if (allScored.length > 1) {
        result.ambiguous.push({ matchedText: segment.raw, candidates: allScored.map((s) => s.entry) });
        continue;
      }
      winner = allScored[0];
    } else {
      // CONFIDENCE FIRST, role only to break an equal-confidence tie.
      //
      // Filtering to the queried role before comparing confidence discarded a stronger identification: with
      // PM "Robert Bell" (exact) and superintendent "Robert Allen Bell" (high), a superintendent-field
      // "Robert Bell" resolved to the superintendent at HIGH while the exact PM — the person actually named
      // — was thrown away. Role cannot outrank evidence when the premise is that the field's role is
      // unreliable.
      const best = allScored.some((s) => s.confidence === "exact") ? "exact" : "high";
      // Narrowed to the BEST EVIDENCE before anything else looks at this set. `high` is coarse, so a person
      // merely sharing the tier is not actually competing: active "John Cheatam" at distance 1 was being
      // blocked by inactive "John Chattam" at distance 2, turning a clear answer into an ambiguity. Blocking
      // is for candidates that remain genuinely tied — which now includes candidates tied ACROSS the two
      // axes, where one spelled the name better and the other heard more of it.
      const atBest = narrowToBestEvidence(allScored.filter((s) => s.confidence === best));

      // An inactive person at the BEST tier blocks the segment, whatever that tier is. Restricting this to
      // exact hits left the fuzzy tie open: "John Smath" scored inactive "John Smith" and active "John
      // Smyth" equally, and dropping the inactive one returned Smyth cleanly — a former employee's
      // corrective action sent to a current colleague. When the evidence cannot separate a deactivated
      // person from an active one, nobody is the only safe answer. An active EXACT still beats an inactive
      // HIGH, because then the inactive is not at the best tier.
      if (atBest.some((s) => !s.entry.isActive)) {
        // Surfaced as AMBIGUOUS when an active person is tied with them, so a human has something to choose
        // between and can see the deactivated namesake that caused the doubt; UNMATCHED when the deactivated
        // person is the only one at that tier, because then there is nobody to offer.
        if (atBest.some((s) => s.entry.isActive)) {
          result.ambiguous.push({ matchedText: segment.raw, candidates: atBest.map((s) => s.entry) });
        } else {
          result.unmatched.push(segment.raw);
        }
        continue;
      }

      // Role last. `atBest` is already narrowed to the best confidence and to evidence no rival beats, so
      // role only ever breaks a genuine tie between equally-good candidates.
      const inRoleAtBest = atBest.filter((s) => s.inRole);
      const finalists = inRoleAtBest.length > 0 ? inRoleAtBest : atBest;
      if (finalists.length > 1) {
        result.ambiguous.push({ matchedText: segment.raw, candidates: finalists.map((s) => s.entry) });
        continue;
      }
      winner = finalists[0];
    }

    // Inactive is absolute: the bare-token branch scores them, so a lone finalist can still be one.
    if (!winner.entry.isActive) {
      result.unmatched.push(segment.raw);
      continue;
    }

    // One person named twice in one field is one recipient — but at their STRONGEST evidence, not whichever
    // segment came first. "Brett/Brett Bell" returned high while "Brett Bell/Brett" returned exact, so a
    // caller gating auto-send on the full-name tier accepted or rejected the same field purely on word order.
    const existing = matchIndexById.get(winner.entry.id);
    if (existing !== undefined) {
      const current = result.matches[existing];
      if (current.confidence !== "exact" && winner.confidence === "exact") {
        result.matches[existing] = {
          ...current,
          confidence: "exact",
          matchedText: segment.raw,
          roleMatchesQuery: winner.roleMatchesQuery,
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
      roleMatchesQuery: winner.roleMatchesQuery,
    });
  }

  return result;
}
