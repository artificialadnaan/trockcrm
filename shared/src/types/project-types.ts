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
