export interface ServiceRfpReportDeal {
  dealId: string;
  dealName: string;
  isActive?: boolean;
  repId: string | null;
  repName: string;
  submittedAt: string | null;
  week: string | null;
  basis: "first_submission" | "historical" | "missing";
}

export interface ServiceRfpReport {
  dateFrom: string;
  dateTo: string;
  timezone: "America/Chicago";
  total: number;
  historicalCount: number;
  missingEvidenceCount: number;
  weeks: string[];
  reps: Array<{ repId: string | null; repName: string; total: number; weekly: Record<string, number> }>;
  deals: ServiceRfpReportDeal[];
  missingEvidence: ServiceRfpReportDeal[];
}
