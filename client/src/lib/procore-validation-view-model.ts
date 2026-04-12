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
  actionLabel?: string;
};

export type ProcoreRedirectBanner = {
  tone: "success" | "destructive";
  title: string;
  description: string;
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

export function canLoadProcoreValidation(status: ProcoreAuthStatus | null) {
  if (!status) {
    return false;
  }

  if (status.connected) {
    return true;
  }

  if (status.status === "reauth_needed") {
    return false;
  }

  if (status.authMode === "oauth") {
    return false;
  }

  return status.authMode === "client_credentials" || status.authMode === "dev";
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
      title: "Using development fallback access",
      description:
        "Procore OAuth is not configured in this environment. Read-only validation can still run using development fallback access.",
    };
  }

  if (status.authMode === "client_credentials") {
    return {
      tone: "warning",
      title: "Using fallback Procore access",
      description:
        "Read-only validation is using the configured client credentials fallback. Connect Procore to switch to shared OAuth access.",
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

function formatProcoreCallbackReason(reason: string | null | undefined) {
  if (!reason) {
    return "unknown error";
  }

  return reason.replace(/_/g, " ");
}

export function getProcoreRedirectBanner({
  procore,
  reason,
}: {
  procore?: string | null;
  reason?: string | null;
}): ProcoreRedirectBanner | null {
  if (procore === "connected") {
    return {
      tone: "success",
      title: "Procore connected",
      description: "Procore OAuth connected successfully.",
    };
  }

  if (procore === "error") {
    return {
      tone: "destructive",
      title: "Procore connection failed",
      description: `Failed to connect Procore: ${formatProcoreCallbackReason(reason)}.`,
    };
  }

  return null;
}
