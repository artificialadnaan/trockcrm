import type { LeadBudgetStatus, LeadPocRole } from "@trock-crm/shared/types";

export const LEAD_POC_ROLE_LABELS: Record<LeadPocRole, string> = {
  property_manager: "Property Manager",
  construction_manager: "Construction Manager",
  director: "Director",
  regional_manager: "Regional Manager",
  regional_vp: "Regional VP",
  vp: "VP",
  asset_manager: "Asset Manager",
  facilities_manager: "Facilities Manager",
  project_manager: "Project Manager",
  other: "Other",
};

export const LEAD_POC_ROLE_FORM_OPTIONS: LeadPocRole[] = [
  "regional_manager",
  "regional_vp",
  "vp",
  "asset_manager",
  "facilities_manager",
  "project_manager",
  "other",
];

export const LEAD_BUDGET_STATUS_LABELS: Record<LeadBudgetStatus, string> = {
  budgeted_q1: "Budgeted Q1",
  budgeted_q2: "Budgeted Q2",
  budgeted_q3: "Budgeted Q3",
  budgeted_q4: "Budgeted Q4",
  not_budgeted: "Not Budgeted",
};

export function formatLeadPocRole(role: string | null | undefined, otherLabel?: string | null) {
  if (role === "other") {
    return otherLabel?.trim() || LEAD_POC_ROLE_LABELS.other;
  }

  if (!role) {
    return "Not provided";
  }

  return LEAD_POC_ROLE_LABELS[role as LeadPocRole] ?? role;
}

export function formatLeadBudgetStatus(status: string | null | undefined) {
  if (!status) {
    return "Not provided";
  }

  return LEAD_BUDGET_STATUS_LABELS[status as LeadBudgetStatus] ?? status;
}
