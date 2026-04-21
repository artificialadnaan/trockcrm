export const LEAD_COMPANY_PREQUAL_FIELD_KEYS = [
  "qualification.projectLocation",
  "qualification.propertyName",
  "qualification.propertyAddress",
  "qualification.propertyCity",
  "qualification.propertyState",
  "qualification.unitCount",
  "qualification.stakeholderName",
  "qualification.stakeholderRole",
  "qualification.projectType",
  "qualification.scopeSummary",
] as const;

export const LEAD_VALUE_ASSIGNMENT_FIELD_KEYS = [
  "estimatedOpportunityValue",
  "qualification.budgetStatus",
  "qualification.budgetQuarter",
  "qualification.specPackageStatus",
  "qualification.checklistStarted",
] as const;

export const LEAD_QUALIFICATION_FIELD_KEYS = [
  ...LEAD_COMPANY_PREQUAL_FIELD_KEYS,
  ...LEAD_VALUE_ASSIGNMENT_FIELD_KEYS,
] as const;

export const LEAD_SCOPING_SUBSET_FIELD_KEYS = [
  "scopingSubset.projectOverview",
  "scopingSubset.propertyDetails",
  "scopingSubset.scopeSummary",
  "scopingSubset.budgetAndBidContext",
  "scopingSubset.initialQuantities",
  "scopingSubset.decisionTimeline",
] as const;

export const OPPORTUNITY_GATE_FIELD_KEYS = [
  "opportunity.preBidMeetingCompleted",
  "opportunity.siteVisitDecision",
  "opportunity.siteVisitCompleted",
] as const;

export const WORKFLOW_GATE_FIELD_LABELS = {
  estimatedOpportunityValue: "Estimated Opportunity Value",
  "qualification.projectLocation": "Project Location",
  "qualification.propertyName": "Property Name",
  "qualification.propertyAddress": "Property Address",
  "qualification.propertyCity": "Property City",
  "qualification.propertyState": "Property State",
  "qualification.unitCount": "Number of Units",
  "qualification.stakeholderName": "Stakeholder Name",
  "qualification.stakeholderRole": "Stakeholder Role",
  "qualification.budgetStatus": "Budget Status",
  "qualification.budgetQuarter": "Budget Quarter",
  "qualification.projectType": "Project Type",
  "qualification.scopeSummary": "Scope Summary",
  "qualification.specPackageStatus": "Spec Package Status",
  "qualification.checklistStarted": "Project Checklist Started",
  "scopingSubset.projectOverview": "Scoping Subset: Project Overview",
  "scopingSubset.propertyDetails": "Scoping Subset: Property Details",
  "scopingSubset.scopeSummary": "Scoping Subset: Scope Summary",
  "scopingSubset.budgetAndBidContext": "Scoping Subset: Budget and Bid Context",
  "scopingSubset.initialQuantities": "Scoping Subset: Initial Quantities",
  "scopingSubset.decisionTimeline": "Scoping Subset: Decision Timeline",
  "opportunity.preBidMeetingCompleted": "Pre-Bid Meeting Completed",
  "opportunity.siteVisitDecision": "Site Visit Decision",
  "opportunity.siteVisitCompleted": "Site Visit Completed",
} as const;
