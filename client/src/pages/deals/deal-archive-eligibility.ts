/**
 * May this viewer archive this deal?
 *
 * Admins: any deal. Everyone else: only a deal they OWN, at any stage — EXCEPT the two cases the server
 * reserves for admins because they void change-order commissions.
 *
 * Stage no longer participates. The previous rule admitted only `opportunity` and the legacy alias `dd`,
 * and `dd` is seeded is_active_pipeline=FALSE, so a rep could archive nothing outside a single stage — the
 * control was dead on almost every real deal, which is how it was reported: a button that does nothing.
 *
 * MUST NEVER BE MORE PERMISSIVE THAN THE SERVER. This helper only decides what the menu renders; deleteDeal
 * and the DELETE route are what enforce. Getting that backwards replaces a dead button with a button that
 * opens a reason dialog and then 403s on submit — a worse version of the same complaint. Both admin-only
 * carve-outs below exist server-side; they are mirrored here so the affordance never appears.
 */
export function canArchiveDeal(
  deal: {
    assignedRepId?: string | null;
    /** True for a change-order CHILD. Deleting one is admin-only — it removes that CO's commission. */
    isChangeOrder?: boolean | null;
    /**
     * Active change-order CHILDREN hanging off this deal. Archiving the parent cascades: every child is
     * voided and each one's earned commission removed, which is the same admin-only operation reached
     * indirectly. Count CHILD deals only — a legacy `deal_change_orders` row is not a deal and does not
     * cascade, so counting it would block an archive the server would have allowed.
     */
    activeChangeOrderChildCount?: number | null;
  },
  user: { id?: string | null; role?: string | null } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (deal.isChangeOrder === true) return false;
  if ((deal.activeChangeOrderChildCount ?? 0) > 0) return false;
  return !!deal.assignedRepId && deal.assignedRepId === user.id;
}
