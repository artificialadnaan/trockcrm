/**
 * Capitalise a person's name for storage.
 *
 * Applied when a user record is written, because the alternative — casing at render time — has to run on
 * every surface that lists people and gets it wrong in a way nobody can override. Stored names are edited
 * by an admin who can see the result, so the data is the right place to fix.
 *
 * THE TEST OF INTENT IS THE WHOLE NAME, NOT EACH WORD.
 *
 * A name containing BOTH an uppercase and a lowercase letter is returned completely untouched: somebody
 * reached for the shift key, and we do not get to second-guess where they put it. Only a UNIFORMLY cased
 * name — all lower ("nick reyes") or all upper ("COREY SANCHEZ") — is rewritten, because uniform case
 * carries no information about intent and is exactly the mess this exists for.
 *
 * The first draft applied that test per TOKEN, which read as more helpful and was quietly destructive
 * (Codex P2): each word was judged alone, so the lowercase particles in "van der Berg" and "de la Cruz"
 * looked like unstyled words and came back "Van Der Berg" and "De La Cruz". Since this runs on EVERY user
 * write, saving an already-correct name would have silently corrupted it — the precise failure the
 * conservative design was meant to rule out. Judging the whole string makes that unreachable.
 *
 * The cost is honest: "shawn McDonald" now stays as typed rather than becoming "Shawn McDonald". Half-
 * cased input is ambiguous, and leaving a human's text alone beats guessing at it.
 *
 * No Mc/Mac special case, on purpose. An all-lowercase "mcshane" becomes "Mcshane", not "McShane" — a real
 * but bounded miss. The alternative heuristic breaks more than it fixes ("macey" → "MacEy"), and an admin
 * who types "McShane" keeps it, because mixed case is preserved. Existing rows are corrected by hand in
 * the one-time backfill, where a human is reading each name.
 */

/** Word separators that start a new capitalised part: spaces are handled by the token split. */
const INTRA_TOKEN_SEPARATORS = /([-'’.])/;

/**
 * Surname particles that stay lowercase when they are not the first word.
 *
 * Only consulted on the uniform-case path — a name with any intentional casing never reaches here — so an
 * incomplete list can only ever under-correct an all-lowercase name, never corrupt a correct one.
 *
 * Position matters: in a FULL name "van johnson" capitalises "Van", because a leading particle there is
 * someone's given name far more often than a dangling preposition. In a standalone SURNAME the opposite
 * holds, which is what the `surname` option is for.
 */
const LOWERCASE_PARTICLES = new Set([
  "van", "von", "der", "den", "de", "del", "della", "di", "da", "das", "dos",
  "du", "la", "le", "los", "las", "bin", "ibn", "al", "ter", "ten", "af", "av",
]);

/**
 * Generational suffixes that are wholly uppercase — "John Smith III", not "John Smith Iii".
 *
 * A SHORT, DELIBERATELY INCOMPLETE LIST, and the incompleteness is the point.
 *
 * The obvious improvement — validate Roman-numeral syntax instead of enumerating — makes this strictly
 * worse, because short Roman numerals collide with real surnames. Checked, not assumed: LI (51), XI (11),
 * DI (501), MI (1001), CI (101), VI (6), DIX (509) and MIX (1009) all parse as valid numerals, and Li and
 * Xi are among the most common surnames on earth. A syntax check would file "john li" as "John LI".
 *
 * So the set covers the suffixes that actually occur and excludes every entry that is also a plausible
 * surname — "vi" and "xi" were dropped for exactly that reason. The cost is that "john smith vi" stays
 * "John Smith Vi" and XIV stays "Xiv"; a sixth- or fourteenth-generation namesake is rarer than a person
 * named Xi, and mislabelling a living person's surname is the worse failure.
 *
 * MULTI-CHARACTER, and only in FINAL position of a multi-word name. A single "V" or "X" is likelier an
 * initial than a suffix and needs no help regardless: a one-letter token already returns uppercase.
 * Only reachable on the uniform-case path, so a name a human already cased is never inspected for this.
 */
const UPPERCASE_SUFFIXES = new Set(["ii", "iii", "iv", "vii", "viii", "ix"]);

/**
 * In an ALL-CAPS name, a two-letter token is left exactly as typed.
 *
 * "AJ SMITH" was being stored as "Aj Smith" — compact initials (AJ, TJ, DJ, JJ, CJ, BJ, RJ) destroyed by
 * a rule that assumed every uppercase run was shouting. Two letters is genuinely ambiguous between
 * initials and a short given name, and nothing in the string resolves it, so the conservative move is to
 * keep the characters the human typed.
 *
 * The acknowledged cost: "ED SMITH" stays "ED Smith" rather than becoming "Ed Smith". That is the user's
 * own text preserved, not data invented — a smaller failure than rewriting someone's initials. Longer
 * tokens still normalise, so "COREY SANCHEZ" → "Corey Sanchez" is unaffected.
 */
function isCompactInitials(token: string, nameIsAllCaps: boolean): boolean {
  return nameIsAllCaps && token.length === 2 && /^\p{Lu}{2}$/u.test(token);
}

function capitalizeFirstLetter(part: string): string {
  if (!part) return part;
  // Index the first CASED character rather than assuming position 0 — a leading "(" or quote would
  // otherwise absorb the capitalisation and leave the letter after it lowercase.
  const index = part.search(/\p{L}/u);
  if (index === -1) return part;
  return part.slice(0, index) + part[index]!.toUpperCase() + part.slice(index + 1);
}

/**
 * Did a human case this name deliberately?
 *
 * Both an uppercase and a lowercase letter ⇒ yes, somewhere, and we leave the entire string alone. All
 * upper or all lower ⇒ no signal, so it is ours to fix.
 */
function hasIntentionalCasing(name: string): boolean {
  return /\p{Lu}/u.test(name) && /\p{Ll}/u.test(name);
}

function properCaseToken(token: string): string {
  if (!token) return token;
  const lowered = token.toLowerCase();
  return lowered
    .split(INTRA_TOKEN_SEPARATORS)
    .map((part) => (INTRA_TOKEN_SEPARATORS.test(part) && part.length === 1 ? part : capitalizeFirstLetter(part)))
    .join("");
}

/**
 * Returns the name with each word capitalised, or the input unchanged when there is nothing to normalise.
 *
 * Collapses runs of whitespace and trims, so " nick   reyes " becomes "Nick Reyes". Returns the value
 * as-is for null/undefined/non-strings so callers can pass an optional field straight through.
 */
export interface ProperCaseNameOptions {
  /**
   * Treat the value as a standalone SURNAME, so a particle in FIRST position stays lowercase.
   *
   * Without it the component columns contradict the full name (Codex P2): "ludwig van beethoven" gives a
   * display_name of "Ludwig van Beethoven", but the surname "van beethoven" normalised on its own has
   * "van" in first position and comes back "Van Beethoven" — and Admin → Field Users renders
   * `{firstName} {lastName}`, so the same person reads "Ludwig Van Beethoven" there. The helper cannot
   * infer which field it was handed; the caller knows, so the caller says.
   */
  surname?: boolean;
}

export function toProperCaseName<T extends string | null | undefined>(
  value: T,
  options: ProperCaseNameOptions = {}
): T {
  if (typeof value !== "string") return value;
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) return collapsed as T;
  // Whitespace is still collapsed for an intentionally-cased name; only the LETTERS are left untouched.
  if (hasIntentionalCasing(collapsed)) return collapsed as T;
  // hasIntentionalCasing already ruled out mixed case, so any uppercase letter means the WHOLE name is
  // uppercase — the only state in which a two-letter run can be read as initials.
  const nameIsAllCaps = /\p{Lu}/u.test(collapsed);
  const tokens = collapsed.split(" ");
  return tokens
    .map((token, index) => {
      const lowered = token.toLowerCase();
      // Generational suffix: last token of a multi-word name. Checked before the particle rule so the
      // two sets can never both claim a token.
      //
      // Trailing punctuation is split off for the lookup and restored afterwards — the set holds bare
      // numerals, so comparing the whole token left the conventionally written "JOHN SMITH III." as
      // "John Smith Iii." (Codex P2).
      if (index > 0 && index === tokens.length - 1) {
        const [, bareSuffix = "", trailingPunctuation = ""] = /^([\p{L}]*)([.,]*)$/u.exec(lowered) ?? [];
        if (bareSuffix && UPPERCASE_SUFFIXES.has(bareSuffix)) {
          return bareSuffix.toUpperCase() + trailingPunctuation;
        }
      }
      // A particle needs a name AFTER it to attach to. In final position there is nothing to precede, so
      // the token is the surname itself — "marco di" is Marco Di, not Marco with a dangling preposition.
      if (
        (index > 0 || options.surname) &&
        index < tokens.length - 1 &&
        LOWERCASE_PARTICLES.has(lowered)
      ) {
        return lowered;
      }
      // AFTER the particle test, not before (Codex P2). "DE" and "LA" are two uppercase letters, so an
      // initials-first ordering claimed them and stored "JOHN DE LA CRUZ" as "John DE LA Cruz". A token
      // that the surrounding name proves is a particle is never initials; the ambiguous case this rule
      // exists for is a token with no such context.
      if (isCompactInitials(token, nameIsAllCaps)) return token;
      return properCaseToken(token);
    })
    .join(" ") as T;
}
