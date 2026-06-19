/**
 * Parse a money bound (e.g. minLinkedValue/maxLinkedValue) from an Express query-param value.
 *
 * `req.query` values are `string | string[] | undefined` at runtime — a repeated param
 * (`?minLinkedValue=1&minLinkedValue=2`) arrives as an ARRAY, and `Number`/`.trim()` on a non-string
 * would throw and surface as a 500. We treat any non-string, blank/whitespace, or non-finite value as
 * "no bound" (undefined) rather than poisoning the query with NaN or crashing the request.
 */
export function parseMoneyBound(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
