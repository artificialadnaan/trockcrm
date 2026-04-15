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

export function getStaleLeadWatchlistMeta(_range?: {
  from?: string;
  to?: string;
}) {
  return {
    label: "Current-state lead watchlist",
    detail: "Snapshot as of today. Not filtered by the selected reporting period.",
  };
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
