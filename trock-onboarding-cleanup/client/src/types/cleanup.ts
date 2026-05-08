export type RecordTypeSingular = "deal" | "lead" | "contact" | "company";
export type RecordType = "deals" | "leads" | "contacts" | "companies";
export type CleanupStatus = "pending" | "completed" | "skipped";

export type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  role: string;
  onboardingCompletedAt?: string | null;
};

export type MissingField = {
  field: string;
  label: string;
  severity: "required" | "review";
};

export type QueueRecord = {
  id: string;
  type: RecordTypeSingular;
  name: string;
  missingFields: MissingField[];
  stage?: { id: string; slug: string; label: string } | null;
  lastActivityDate?: string | null;
  cleanupStatus: CleanupStatus;
  hubspotExtraPropertyKeys: string[];
};

export type QueueResponse = Record<RecordTypeSingular, QueueRecord[]>;

export type ProgressResponse = {
  totalAssigned: number;
  completed: number;
  skipped: number;
  remaining: number;
  canClearGate: boolean;
};

export type RecordDetail = {
  type: RecordTypeSingular;
  id: string;
  data: Record<string, unknown>;
  stage?: { id: string; slug: string; label: string } | null;
  assignedTo?: { id: string; email: string; displayName: string } | null;
  sourceHubSpotSnapshot: Record<string, unknown>;
  missingFields: MissingField[];
  hubspotExtraPropertyKeys: string[];
};

export type SkipReason =
  | "contact_left_company"
  | "deal_stalled"
  | "customer_unreachable"
  | "record_is_duplicate"
  | "record_is_junk"
  | "historical_no_enrichment_needed"
  | "missing_information_not_available"
  | "other";

export const TYPE_TO_SINGULAR: Record<RecordType, RecordTypeSingular> = {
  deals: "deal",
  leads: "lead",
  contacts: "contact",
  companies: "company",
};

export const SINGULAR_TO_TYPE: Record<RecordTypeSingular, RecordType> = {
  deal: "deals",
  lead: "leads",
  contact: "contacts",
  company: "companies",
};

export const RECORD_TYPES: RecordType[] = ["deals", "leads", "contacts", "companies"];
