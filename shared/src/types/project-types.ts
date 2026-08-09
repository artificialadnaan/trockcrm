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
 * KNOWN LIMIT, stated rather than papered over: the SQL form has a middle tier the client cannot reach —
 * the configured digit on `project_type_config.code`, resolved through `deals.project_type_id`. The client
 * is not given that table, so a deal typed ONLY by its config FK, with `project_type` text left empty,
 * still falls through to the route here. In practice `applyProjectTypeChange` writes the text and the FK
 * in lockstep, so that shape is confined to legacy/imported rows. Closing it needs the server to ship its
 * verdict on the deal payload; until then this is a narrower gap than the one it replaces, not a claim of
 * full parity.
 */
export function isServiceProjectDeal(deal: {
  projectType?: string | null;
  workflowRoute?: string | null;
}): boolean {
  const normalized = normalizeProjectType(String(deal.projectType ?? ""));
  // A VALID type is decisive in both directions: roofing on the service route is NOT service.
  if (normalized && isProjectTypeValue(normalized)) return normalized === "service";
  return deal.workflowRoute === "service";
}
