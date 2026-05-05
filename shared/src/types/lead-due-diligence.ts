export type ExistingCustomerSignalSource = "company" | "contact" | "property";

export interface ExistingCustomerSignal {
  source: ExistingCustomerSignalSource;
  type: string;
  occurredAt: Date;
  detail: string;
}

export interface NoRecentCustomerActivitySignal {
  source: "none";
  type: "no_recent_activity";
  occurredAt: null;
  detail: string;
}

export type LeadDueDiligenceDetectionSignal =
  | ExistingCustomerSignal
  | NoRecentCustomerActivitySignal;

export interface ExistingCustomerDecision {
  isExisting: boolean;
  signal: ExistingCustomerSignal | null;
}
