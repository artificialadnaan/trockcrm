export interface StageGateOption {
  value: string;
  label: string;
  description?: string;
}

export const STAGE_GATE_FIELD_OPTIONS: StageGateOption[] = [
  { value: "primaryContactId", label: "Primary Contact" },
  { value: "companyId", label: "Company" },
  { value: "projectTypeId", label: "Project Type" },
  { value: "regionId", label: "Region" },
  { value: "expectedCloseDate", label: "Expected Close Date" },
  { value: "ddEstimate", label: "DD Estimate" },
  { value: "bidEstimate", label: "Bid Estimate" },
  { value: "awardedAmount", label: "Awarded Amount" },
  { value: "propertyAddress", label: "Property Address" },
  { value: "propertyCity", label: "Property City" },
  { value: "propertyState", label: "Property State" },
  { value: "propertyZip", label: "Property Zip" },
  { value: "winProbability", label: "Win Probability" },
  { value: "description", label: "Description" },
  { value: "lostReasonId", label: "Lost Reason" },
  { value: "lostNotes", label: "Lost Notes" },
  { value: "lostCompetitor", label: "Lost Competitor" },
];

export const STAGE_GATE_DOCUMENT_OPTIONS: StageGateOption[] = [
  { value: "photo", label: "Photo" },
  { value: "contract", label: "Contract" },
  { value: "rfp", label: "RFP" },
  { value: "estimate", label: "Estimate" },
  { value: "change_order", label: "Change Order" },
  { value: "proposal", label: "Proposal" },
  { value: "permit", label: "Permit" },
  { value: "inspection", label: "Inspection" },
  { value: "correspondence", label: "Correspondence" },
  { value: "insurance", label: "Insurance" },
  { value: "warranty", label: "Warranty" },
  { value: "closeout", label: "Closeout" },
  { value: "other", label: "Other" },
];

export const STAGE_GATE_APPROVAL_OPTIONS: StageGateOption[] = [
  { value: "director", label: "Director Approval" },
  { value: "admin", label: "Admin Approval" },
];

export function filterKnownStageGateValues(values: string[], options: StageGateOption[]): string[] {
  const allowed = new Set(options.map((option) => option.value));
  return values.filter((value, index) => allowed.has(value) && values.indexOf(value) === index);
}

export function toggleStageGateValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}
