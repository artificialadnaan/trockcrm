export interface SalesReviewFilters {
  from?: string;
  to?: string;
  repId?: string;
  forecastWindow?: "30_days" | "60_days" | "90_days" | "beyond_90" | "uncommitted";
}

export interface SalesReviewForecastRow {
  entityType: "lead" | "deal";
  id: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  propertyId: string | null;
  propertyName: string | null;
  stageId: string;
  assignedRepId: string;
  assignedRepName: string;
  forecastWindow: "30_days" | "60_days" | "90_days" | "beyond_90" | "uncommitted";
  forecastCategory: "commit" | "best_case" | "pipeline" | null;
  forecastConfidencePercent: number | null;
  forecastRevenue: number | null;
  forecastGrossProfit: number | null;
  forecastBlockers: string | null;
  nextStep: string | null;
  nextMilestoneAt: string | null;
  supportNeededType: string | null;
}

export interface SalesReviewActivityCadenceRow {
  repId: string;
  repName: string;
  calls7d: number;
  calls14d: number;
  calls30d: number;
  emails7d: number;
  emails14d: number;
  emails30d: number;
  meetings7d: number;
  meetings14d: number;
  meetings30d: number;
  lunches7d: number;
  lunches14d: number;
  lunches30d: number;
  siteVisits7d: number;
  siteVisits14d: number;
  siteVisits30d: number;
  proposalsSent7d: number;
  proposalsSent14d: number;
  proposalsSent30d: number;
  followUps7d: number;
  followUps14d: number;
  followUps30d: number;
}

export interface SalesHygieneIssueRow {
  entityType: "lead" | "deal";
  id: string;
  name: string;
  assignedRepId: string;
  assignedRepName: string;
  issueTypes: string[];
  stageId: string;
  nextStep: string | null;
  nextMilestoneAt: string | null;
  lastActivityAt: string | null;
  updatedAt: string;
}

export interface SalesReviewOverview {
  newOpportunities: Array<{
    entityType: "lead" | "deal";
    id: string;
    name: string;
    assignedRepId: string;
    assignedRepName: string;
    companyName: string | null;
    propertyName: string | null;
    createdAt: string;
    stageId: string;
  }>;
  forecast: SalesReviewForecastRow[];
  activityCadence: SalesReviewActivityCadenceRow[];
  hygiene: SalesHygieneIssueRow[];
  supportRequests: SalesReviewForecastRow[];
}
