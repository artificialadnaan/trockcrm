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
  return collapsed
    .split(" ")
    .map((token, index) =>
      (index > 0 || options.surname) && LOWERCASE_PARTICLES.has(token.toLowerCase())
        ? token.toLowerCase()
        : properCaseToken(token)
    )
    .join(" ") as T;
}
