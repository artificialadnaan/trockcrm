export const PROJECT_TYPE_OPTIONS = [
  { label: "Exterior Renovation", value: "exterior renovation", code: "1" },
  { label: "Interior Renovation", value: "interior renovation", code: "2" },
  { label: "Roofing", value: "roofing", code: "3" },
  { label: "Service", value: "service", code: "4" },
  { label: "Commercial", value: "commercial", code: "5" },
  { label: "Hospitality", value: "hospitality", code: "6" },
  { label: "Emergency", value: "emergency", code: "7" },
  { label: "Development", value: "development", code: "8" },
  { label: "Residential", value: "residential", code: "9" },
] as const;

export type ProjectTypeValue = (typeof PROJECT_TYPE_OPTIONS)[number]["value"];

export const PROJECT_TYPE_VALUES = PROJECT_TYPE_OPTIONS.map((option) => option.value) as ProjectTypeValue[];

export const PROJECT_TYPE_CODE_BY_VALUE = Object.fromEntries(
  PROJECT_TYPE_OPTIONS.map((option) => [option.value, option.code])
) as Record<ProjectTypeValue, string>;

/** Inverse of PROJECT_TYPE_CODE_BY_VALUE: the "1".."9" digit code → the canonical type value.
 *  Used where a UI submits the SyncHub-style digit (e.g. the RFP vote form's project_types select)
 *  and the CRM must persist `deals.project_type` as the value string. */
export const PROJECT_TYPE_VALUE_BY_CODE = Object.fromEntries(
  PROJECT_TYPE_OPTIONS.map((option) => [option.code, option.value])
) as Record<string, ProjectTypeValue>;

export function normalizeProjectType(value: string): string {
  return value.trim().toLowerCase();
}

export function isProjectTypeValue(value: string): value is ProjectTypeValue {
  return PROJECT_TYPE_VALUES.includes(normalizeProjectType(value) as ProjectTypeValue);
}

/**
 * "Is this deal service?", answered the way the platform defines it — project type FIRST, workflow route
 * only as a fallback. Mirrors `resolveProjectTypeCode(...) === '4'` and the SQL in
 * `aliasedIsServiceProjectSql`, and lives in shared/ so the client cannot answer it differently.
 *
 * WHY THIS EXISTS. `deals.workflow_route` is NOT NULL DEFAULT 'normal' and nothing derived it from the
 * project type, so a route of 'normal' has never meant "not service" — it usually meant nobody said. The
 * client's At Risk cards, kanban narrowing and drill-down all tested that column alone, which put deals
 * whose own numbers read DFW-4-… on the non-service side of a split the reports had already corrected.
 *
 * THREE TIERS, in the canonical order, matching `aliasedIsServiceProjectSql` exactly:
 *   1. a VALID `projectType` -> decisive in BOTH directions (roofing on the service route is NOT service);
 *   2. else the CONFIGURED digit (`project_type_config.code` via `project_type_id`), which the server ships
 *      on the deal payload as `projectTypeCode`;
 *   3. else, and only else, the route.
 *
 * TIER 2 IS NOT AN EDGE CASE, and an earlier draft of this helper wrongly dismissed it as one. Measured on
 * production: 646 of 1,351 active deals carry no `project_type` TEXT at all and are typed ONLY by the FK,
 * and 277 of the 279 currently-misclassified deals are in exactly that shape. Falling through to the route
 * without tier 2 would therefore have left the client disagreeing with the reports for essentially the
 * whole population this release exists to fix.
 */
export function isServiceProjectDeal(deal: {
  projectType?: string | null;
  projectTypeCode?: string | null;
  workflowRoute?: string | null;
}): boolean {
  const normalized = normalizeProjectType(String(deal.projectType ?? ""));
  if (normalized && isProjectTypeValue(normalized)) return normalized === "service";

  const code = String(deal.projectTypeCode ?? "").trim();
  if (/^[1-9]$/.test(code)) return code === PROJECT_TYPE_CODE_BY_VALUE.service;

  return deal.workflowRoute === "service";
}
