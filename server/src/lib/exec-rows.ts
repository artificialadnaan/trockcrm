/**
 * Normalize a Drizzle `.execute(sql...)` result to a plain rows array across driver shapes. node-postgres returns
 * a `QueryResult` with `.rows`; some drivers (and PGlite in tests) return the rows array directly. One helper so
 * every raw-SQL call site unwraps identically (finding Z6).
 */
export function unwrapExecRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}
