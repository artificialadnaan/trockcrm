/**
 * PostgreSQL error-code predicates shared by rollout-compatible database callers.
 * Drizzle can wrap the original PostgreSQL error in `cause`, so check both shapes.
 */
export function isUndefinedFunctionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return candidate?.code === "42883" || candidate?.cause?.code === "42883";
}
