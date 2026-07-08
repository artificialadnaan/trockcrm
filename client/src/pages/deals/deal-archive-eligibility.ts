import { isOpportunityStageSlug } from "@trock-crm/shared/types";

export function canArchiveDeal(
  deal: { stageSlug?: string | null; assignedRepId?: string | null },
  user: { id?: string | null; role?: string | null } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const isOwner = !!deal.assignedRepId && deal.assignedRepId === user.id;
  return isOwner && isOpportunityStageSlug(deal.stageSlug);
}
