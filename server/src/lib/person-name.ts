/**
 * Capitalise a person's name for storage.
 *
 * Applied when a user record is written, because the alternative — casing at render time — has to run on
 * every surface that lists people and gets it wrong in a way nobody can override. Stored names are edited
 * by an admin who can see the result, so the data is the right place to fix.
 *
 * DELIBERATELY CONSERVATIVE. A token that already carries an internal capital is returned UNTOUCHED:
 * "McCarty", "DeSantis", "O'Brien", "van der Berg" survive verbatim. Only an all-lowercase or all-uppercase
 * token is re-cased, which is exactly the mess this exists for ("nick reyes", "COREY MCSHANE") and nothing
 * else. The rule matters more than it looks: a naive title-case pass turns the correctly-stored "Edward
 * McCarty" into "Edward Mccarty", i.e. it CORRUPTS good data to fix bad data.
 *
 * No Mc/Mac special case, on purpose. "mcshane" therefore becomes "Mcshane", not "McShane" — a real but
 * bounded miss. The alternative heuristic breaks more than it fixes ("macey" → "MacEy"), and an admin who
 * types "McShane" keeps it, because mixed case is preserved. Existing rows are corrected by hand in the
 * one-time backfill, where a human is reading each name.
 */

/** Word separators that start a new capitalised part: spaces are handled by the token split. */
const INTRA_TOKEN_SEPARATORS = /([-'’.])/;

function capitalizeFirstLetter(part: string): string {
  if (!part) return part;
  // Index the first CASED character rather than assuming position 0 — a leading "(" or quote would
  // otherwise absorb the capitalisation and leave the letter after it lowercase.
  const index = part.search(/\p{L}/u);
  if (index === -1) return part;
  return part.slice(0, index) + part[index]!.toUpperCase() + part.slice(index + 1);
}

function hasInternalCapital(token: string): boolean {
  const letters = token.match(/\p{L}/gu);
  if (!letters || letters.length < 2) return false;
  // An ALL-CAPS token is not a casing decision, it is shouting — "COREY" must still normalise to "Corey".
  // Requiring a lowercase letter somewhere is what separates the two: "McCarty" has one, "COREY" does not.
  const hasLower = letters.some((letter) => letter !== letter.toUpperCase());
  if (!hasLower) return false;
  // An uppercase letter after the first cased character means a human made a casing decision here.
  return letters.slice(1).some((letter) => letter !== letter.toLowerCase());
}

function properCaseToken(token: string): string {
  if (!token) return token;
  if (hasInternalCapital(token)) return token;
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
export function toProperCaseName<T extends string | null | undefined>(value: T): T {
  if (typeof value !== "string") return value;
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) return collapsed as T;
  return collapsed.split(" ").map(properCaseToken).join(" ") as T;
}
