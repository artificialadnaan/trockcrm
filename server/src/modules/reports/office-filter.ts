import { sql, type SQL } from "drizzle-orm";

export const OFFICE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OfficeMatcherColumns {
  /** SQL fragment for offices.id (e.g. sql`o.id`, sql`office_scope.id`). */
  officeId: SQL;
  /** SQL fragment for offices.slug. */
  officeSlug: SQL;
  /** SQL fragment for offices.name. */
  officeName: SQL;
  /** Optional: SQL fragment for deals.office_code if available in scope. */
  dealOfficeCode?: SQL;
}

/**
 * Build a SQL filter that matches an office identifier against UUID, slug,
 * name, or deal office_code (case-insensitive). Returns `null` when the
 * filter should be skipped (no value, or "all").
 *
 * Why: Frontend office selects now emit canonical UUIDs, but legacy URLs and
 * older callers still pass slugs or office_codes. Each tier service used to
 * inline its own variant of this matching, which drifted out of sync (see
 * Codex findings on Tier 2 office regression). Centralizing here prevents
 * future drift.
 */
export function buildOfficeMatcher(
  value: string | null | undefined,
  columns: OfficeMatcherColumns,
): SQL | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.toLowerCase() === "all") return null;

  const clauses: SQL[] = [
    sql`${columns.officeId}::text = ${trimmed}`,
    sql`LOWER(COALESCE(${columns.officeSlug}, '')) = LOWER(${trimmed})`,
    sql`LOWER(COALESCE(${columns.officeName}, '')) = LOWER(${trimmed})`,
  ];
  if (columns.dealOfficeCode) {
    clauses.push(
      sql`LOWER(COALESCE(${columns.dealOfficeCode}, '')) = LOWER(${trimmed})`,
    );
  }
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

/**
 * Variant used when offices are NOT joined into the query. Wraps an EXISTS
 * lookup against the offices table. Requires that `u` (users) and `d` (deals)
 * are in scope for the surrounding query.
 */
export function buildOfficeExistsMatcher(
  value: string | null | undefined,
): SQL | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.toLowerCase() === "all") return null;
  // The direct `d.office_code` match is a top-level OR, parallel to the
  // EXISTS lookup, so legacy office_code values that do not correspond to any
  // offices row (e.g., historical short codes) still match deals carrying
  // that code. Without this fallback the EXISTS-only path would silently drop
  // those filters.
  return sql`(
    LOWER(COALESCE(d.office_code, '')) = LOWER(${trimmed})
    OR EXISTS (
      SELECT 1 FROM offices office_scope
      WHERE (
        office_scope.id::text = ${trimmed}
        OR LOWER(COALESCE(office_scope.slug, '')) = LOWER(${trimmed})
        OR LOWER(COALESCE(office_scope.name, '')) = LOWER(${trimmed})
      )
      AND (
        u.office_id = office_scope.id
        OR LOWER(COALESCE(d.office_code, '')) = LOWER(office_scope.slug)
        OR LOWER(COALESCE(d.office_code, '')) = LOWER(office_scope.name)
        OR COALESCE(d.office_code, '') = office_scope.id::text
      )
    )
  )`;
}

/**
 * Pick the first non-empty string value among the candidates. Used for
 * query params with legacy aliases (e.g., `dateFrom` vs `from`) where
 * the modern alias might be present-but-empty.
 *
 * Accepts `unknown` so callers never need `as string | string[] | undefined`
 * casts when passing Express `ParsedQs` values. Non-string / non-array values
 * (objects, numbers, null) fall through silently.
 */
export function pickQueryValue(
  ...candidates: unknown[]
): string | undefined {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string" && item.trim()) return item.trim();
      }
      continue;
    }
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    // Non-string/non-array values (objects, numbers, null) fall through.
  }
  return undefined;
}
