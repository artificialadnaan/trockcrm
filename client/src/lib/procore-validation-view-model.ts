type ValidationStatus = "matched" | "ambiguous" | "unmatched";

type ValidationSummaryInput = {
  status: ValidationStatus;
};

type ValidationMatchReason =
  | "procore_project_id"
  | "duplicate_procore_project_id"
  | "project_number"
  | "duplicate_project_number"
  | "name_location"
  | "name_location_tie"
  | "none";

export function buildValidationSummary(rows: ValidationSummaryInput[]) {
  return rows.reduce(
    (summary, row) => {
      summary.total += 1;
      summary[row.status] += 1;
      return summary;
    },
    {
      matched: 0,
      ambiguous: 0,
      unmatched: 0,
      total: 0,
    }
  );
}

export function formatValidationMatchReason(reason: ValidationMatchReason) {
  switch (reason) {
    case "procore_project_id":
      return "Linked by Procore project ID";
    case "duplicate_procore_project_id":
      return "Duplicate Procore project link";
    case "project_number":
      return "Matched by project number";
    case "duplicate_project_number":
      return "Ambiguous project number match";
    case "name_location":
      return "Matched by name and location";
    case "name_location_tie":
      return "Ambiguous name and location match";
    case "none":
    default:
      return "No CRM match";
  }
}
