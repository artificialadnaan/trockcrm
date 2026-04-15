export interface StaleLeadViewRow {
  leadId: string;
  leadName: string;
  companyName: string;
  propertyName: string;
  stageName: string;
  repName: string;
  daysInStage: number;
}

export interface StaleLeadAlertSummary {
  title: string;
  detail: string;
}

export function buildStaleLeadAlertSummary(
  lead: StaleLeadViewRow | null | undefined,
  fallbackTitle: string,
  fallbackDetail: string
): StaleLeadAlertSummary {
  if (!lead) {
    return {
      title: fallbackTitle,
      detail: fallbackDetail,
    };
  }

  return {
    title: lead.leadName,
    detail: `${lead.daysInStage}d stale - ${lead.repName} - ${lead.stageName}`,
  };
}
