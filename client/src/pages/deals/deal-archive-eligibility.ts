/**
 * May this viewer archive this deal?
 *
 * Admins: any deal. Everyone else: only a deal they OWN — at any stage.
 *
 * The stage no longer participates. The previous rule admitted only `opportunity` and the legacy alias
 * `dd`, and `dd` is seeded is_active_pipeline=FALSE, so in practice a rep could archive nothing outside a
 * single stage — the control was dead on almost every real deal, which is how it was reported: as a button
 * that does nothing.
 *
 * Kept in lockstep with the SERVER, which is the gate that actually enforces this (deleteDeal). This helper
 * only decides what the menu renders; it must never be more permissive than the server, or the button opens
 * a dialog whose submit then 403s.
 */
export function canArchiveDeal(
  deal: { assignedRepId?: string | null },
  user: { id?: string | null; role?: string | null } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return !!deal.assignedRepId && deal.assignedRepId === user.id;
}
