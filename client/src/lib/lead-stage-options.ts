import {
  LEAD_COMPANY_PREQUAL_FIELD_KEYS,
  LEAD_SCOPING_SUBSET_FIELD_KEYS,
  LEAD_VALUE_ASSIGNMENT_FIELD_KEYS,
  OPPORTUNITY_GATE_FIELD_KEYS,
  WORKFLOW_GATE_FIELD_LABELS,
} from "../../../shared/src/types/workflow-gates.js";

export interface StageGateOption {
  value: string;
  label: string;
  description?: string;
}

export interface StageGateOptionGroup {
  key: string;
  title: string;
  options: StageGateOption[];
}

export function buildStageGateOptions(fieldKeys: readonly string[]) {
  return fieldKeys.map((value) => ({
    value,
    label: WORKFLOW_GATE_FIELD_LABELS[value as keyof typeof WORKFLOW_GATE_FIELD_LABELS] ?? value,
  }));
}

export const LEAD_STAGE_GATE_OPTION_GROUPS: StageGateOptionGroup[] = [
  {
    key: "lead_company_prequal",
    title: "Lead Company Pre-Qualification",
    options: buildStageGateOptions(LEAD_COMPANY_PREQUAL_FIELD_KEYS),
  },
  {
    key: "lead_value_assignment",
    title: "Lead Value Assignment",
    options: buildStageGateOptions(LEAD_VALUE_ASSIGNMENT_FIELD_KEYS),
  },
  {
    key: "lead_scoping_subset",
    title: "Lead Scoping Subset",
    options: buildStageGateOptions(LEAD_SCOPING_SUBSET_FIELD_KEYS),
  },
  {
    key: "opportunity_gate",
    title: "Opportunity Review",
    options: buildStageGateOptions(OPPORTUNITY_GATE_FIELD_KEYS),
  },
];
