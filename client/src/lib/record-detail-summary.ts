export interface DealDetailSummary {
  ageDays: number;
  freshnessDays: number;
  bestValue: number;
  hasNextStep: boolean;
  hasOwner: boolean;
}

export interface LeadDetailSummary {
  ageDays: number;
  freshnessDays: number;
  hasOwner: boolean;
  isConverted: boolean;
  hasNextStep: boolean;
}

function diffDays(from: string | null | undefined, now: Date) {
  if (!from) return 0;
  const date = new Date(from);
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function toNumber(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildDealDetailSummary(
  deal: {
    stageEnteredAt: string;
    updatedAt: string;
    ddEstimate?: string | null;
    bidEstimate?: string | null;
    awardedAmount?: string | null;
    nextStep?: string | null;
    assignedRepId?: string | null;
  },
  now = new Date()
): DealDetailSummary {
  return {
    ageDays: diffDays(deal.stageEnteredAt, now),
    freshnessDays: diffDays(deal.updatedAt, now),
    bestValue:
      toNumber(deal.awardedAmount) || toNumber(deal.bidEstimate) || toNumber(deal.ddEstimate),
    hasNextStep: Boolean(deal.nextStep),
    hasOwner: Boolean(deal.assignedRepId),
  };
}

export function buildLeadDetailSummary(
  lead: {
    stageEnteredAt: string;
    updatedAt: string;
    assignedRepId?: string | null;
    convertedAt?: string | null;
    convertedDealId?: string | null;
    status?: string | null;
    nextStep?: string | null;
  },
  now = new Date()
): LeadDetailSummary {
  return {
    ageDays: diffDays(lead.stageEnteredAt, now),
    freshnessDays: diffDays(lead.updatedAt, now),
    hasOwner: Boolean(lead.assignedRepId),
    isConverted: Boolean(lead.convertedAt || lead.convertedDealId || lead.status === "converted"),
    hasNextStep: Boolean(lead.nextStep),
  };
}
