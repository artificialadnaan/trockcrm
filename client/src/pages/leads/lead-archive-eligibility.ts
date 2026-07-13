export function canArchiveLead(
  lead: { assignedRepId?: string | null; isActive?: boolean; status?: string | null },
  user: { id?: string | null; role?: string | null } | null | undefined,
): boolean {
  if (!user || lead.isActive !== true || lead.status !== "open") return false;
  if (user.role === "admin") return true;
  return Boolean(lead.assignedRepId && lead.assignedRepId === user.id);
}
