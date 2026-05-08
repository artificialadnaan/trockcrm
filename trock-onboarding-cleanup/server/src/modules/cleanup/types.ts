export const RECORD_TYPES = ["deal", "lead", "contact", "company"] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export type CleanupStatus = "pending" | "completed" | "skipped";

export type AuthContext = {
  id: string;
  email: string;
  role: string;
};

export type MissingField = {
  field: string;
  label: string;
  severity: "required" | "review";
};

export type RecordDetail = {
  type: RecordType;
  id: string;
  data: Record<string, unknown>;
  stage?: {
    id: string;
    slug: string;
    label: string;
  } | null;
  assignedTo?: {
    id: string;
    email: string;
    displayName: string;
  } | null;
  sourceHubSpotSnapshot: Record<string, unknown>;
  missingFields: MissingField[];
  hubspotExtraPropertyKeys: string[];
};
