type ValidationStatus = "matched" | "ambiguous" | "unmatched";
type ProcoreAuthMode = "oauth" | "client_credentials" | "dev";

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

export type ProcoreAuthStatus = {
  connected: boolean;
  expiresAt?: string | null;
  accountEmail?: string | null;
  accountName?: string | null;
  status?: string | null;
  errorMessage?: string | null;
  authMode: ProcoreAuthMode;
};

type ProcoreConnectionBanner = {
  tone: "warning" | "destructive";
  title: string;
  description: string;
  actionLabel: string;
};

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

export function getProcoreConnectionBanner(
  status: ProcoreAuthStatus | null
): ProcoreConnectionBanner | null {
  if (!status || status.connected) {
    return null;
  }

  if (status.status === "reauth_needed") {
    return {
      tone: "destructive",
      title: "Procore reconnection required",
      description: status.errorMessage
        ? `Procore needs to be reconnected before project validation can run. (${status.errorMessage})`
        : "Procore needs to be reconnected before project validation can run.",
      actionLabel: "Reconnect Procore",
    };
  }

  if (status.authMode === "dev") {
    return {
      tone: "warning",
      title: "Procore OAuth unavailable",
      description:
        "Procore OAuth is not configured in this environment, so project validation cannot run.",
      actionLabel: "Connect Procore",
    };
  }

  return {
    tone: "warning",
    title: "Connect Procore to run validation",
    description:
      "Project validation only runs against an authenticated Procore session. Connect Procore to load live projects.",
    actionLabel: "Connect Procore",
  };
}
