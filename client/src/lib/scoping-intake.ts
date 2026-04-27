export type WorkflowRoute = "normal" | "service";

export interface ScopingCompletionStateEntry {
  isComplete: boolean;
  missingFields: string[];
  missingAttachments: string[];
}

const SECTION_LABELS: Record<string, string> = {
  projectOverview: "Project Overview",
  propertyDetails: "Property Details",
  scopeSummary: "Scope Summary",
  opportunity: "Opportunity Review",
  attachments: "Attachments",
};

const FIELD_LABELS: Record<string, string> = {
  propertyName: "Property Name",
  bidDueDate: "Bid Due Date",
  propertyAddress: "Property Address",
  propertyCity: "Property City",
  propertyState: "Property State",
  propertyZip: "Property Zip",
  summary: "Summary",
  preBidMeetingCompleted: "Pre-Bid Meeting Completed",
  estimatorConsultationNotes: "Estimator Consultation Notes",
  siteVisitDecision: "Site Visit Decision",
  siteVisitCompleted: "Site Visit Completed",
};

function startCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatScopingFieldLabel(value: string) {
  const [sectionKey, fieldKey] = value.split(".");

  if (!fieldKey) {
    return FIELD_LABELS[value] ?? startCase(value);
  }

  const sectionLabel = SECTION_LABELS[sectionKey] ?? startCase(sectionKey);
  const fieldLabel = FIELD_LABELS[fieldKey] ?? startCase(fieldKey);
  return `${sectionLabel}: ${fieldLabel}`;
}

export function formatScopingAttachmentLabel(value: string) {
  const normalized = value.replace(/_/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function summarizeScopingRoute(route: WorkflowRoute | null | undefined) {
  if (!route) {
    return "Opportunity Review Pending";
  }
  return route === "service" ? "Ready for Service Pipeline" : "Ready for Standard Pipeline";
}

export function getScopingCompletionCounts(
  completionState: Record<string, ScopingCompletionStateEntry> | null | undefined
) {
  const entries = Object.values(completionState ?? {});

  return {
    completed: entries.filter((entry) => entry.isComplete).length,
    total: entries.length,
  };
}

export function buildScopingSeedFromDeal(deal: {
  name: string;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  description: string | null;
}) {
  return {
    projectOverview: {
      propertyName: deal.name ?? "",
    },
    propertyDetails: {
      propertyAddress: deal.propertyAddress ?? "",
      propertyCity: deal.propertyCity ?? "",
      propertyState: deal.propertyState ?? "",
      propertyZip: deal.propertyZip ?? "",
    },
    scopeSummary: {
      summary: deal.description ?? "",
    },
    opportunity: {
      preBidMeetingCompleted: "",
      estimatorConsultationNotes: "",
      siteVisitDecision: "",
      siteVisitCompleted: "",
    },
    attachments: {},
  };
}

export function buildScopingSeedFromResolvedFields(resolved: {
  propertyName: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  description: string | null;
  bidDueDate: string | boolean | number | null;
}) {
  return {
    projectOverview: {
      propertyName: resolved.propertyName ?? "",
      bidDueDate: typeof resolved.bidDueDate === "string" ? resolved.bidDueDate : "",
    },
    propertyDetails: {
      propertyAddress: resolved.propertyAddress ?? "",
      propertyCity: resolved.propertyCity ?? "",
      propertyState: resolved.propertyState ?? "",
      propertyZip: resolved.propertyZip ?? "",
    },
    scopeSummary: {
      summary: resolved.description ?? "",
    },
    opportunity: {
      preBidMeetingCompleted: "",
      estimatorConsultationNotes: "",
      siteVisitDecision: "",
      siteVisitCompleted: "",
    },
    attachments: {},
  };
}
