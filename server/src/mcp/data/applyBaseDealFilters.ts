import { sql, type SQL } from "drizzle-orm";
import { aliasedActiveDealCountFilterSql } from "../../modules/shared/deal-value-sql.js";
import { WON_STAGE_SLUGS } from "../../modules/shared/pipeline-terminal-stages.js";

/** Re-exported so every demo deal tool uses the ONE canonical Won-stage set, never a name match. */
export { WON_STAGE_SLUGS };

const ALIAS_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(`Invalid deal table alias: ${JSON.stringify(alias)}`);
  }
}

/**
 * The ONE base WHERE every demo deal query composes — the single source of truth so the demo can
 * never drift from CRM reporting (drift across surfaces is a bug class this codebase has already
 * had to fix once).
 *
 * Composes, for the given deals alias:
 *   1. is_active = true
 *   2. is_test_data = false
 *   3. NOT on hold — via the canonical `aliasedActiveDealCountFilterSql` (the exact reporting
 *      on-hold exclusion: `COALESCE(<alias>.on_hold, false) = false`), reused, never reimplemented.
 *
 * Plus two read-surface conventions enforced by convention + test (not expressible as a row filter):
 *   4. Won is the canonical 6-slug family ({@link WON_STAGE_SLUGS}), via {@link wonStageSlugFilterSql}.
 *   5/6. Tools read ONLY `deals` (+ `pipeline_stage_config` for slugs) — never `staged_*` tables and
 *        never an unbounded `audit_log`.
 */
export function applyBaseDealFilters(alias: string): SQL {
  assertAlias(alias);
  const isActive = sql.raw(`${alias}.is_active = true`);
  const notTestData = sql.raw(`COALESCE(${alias}.is_test_data, false) = false`);
  return sql`${aliasedActiveDealCountFilterSql(alias)} AND ${isActive} AND ${notTestData}`;
}

/**
 * Canonical Won-stage filter: `<stageSlugColumn> IN (<the 6 canonical Won slugs>)`. Use this (never a
 * stage-name comparison) wherever a tool scopes to Won. The slug column is validated as an identifier
 * and the slugs are bound as parameters.
 */
export function wonStageSlugFilterSql(stageSlugColumn: string): SQL {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(stageSlugColumn)) {
    throw new Error(`Invalid stage slug column: ${JSON.stringify(stageSlugColumn)}`);
  }
  return sql`${sql.raw(stageSlugColumn)} IN (${sql.join(
    WON_STAGE_SLUGS.map((slug) => sql`${slug}`),
    sql`, `
  )})`;
}
