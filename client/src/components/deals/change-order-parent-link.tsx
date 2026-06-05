import { Link } from "react-router-dom";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChangeOrderParentLinkProps {
  /** The parent project deal this change order belongs to (`deals.parent_deal_id`). */
  parentDealId: string;
  /**
   * A human label for the parent — typically the child's own `projectNumber`, which a CO child
   * shares with its parent (migration 0156 exempts CO children from the project-number unique index).
   * Fetch-free: no extra round-trip just to render the link.
   */
  parentLabel?: string | null;
  className?: string;
}

/**
 * On a Change Order CHILD deal's detail view, shows + links to its parent project deal so a user can
 * navigate child → parent. Stays behind the CRM data the page already has (no Procore, no extra fetch).
 */
export function ChangeOrderParentLink({ parentDealId, parentLabel, className }: ChangeOrderParentLinkProps) {
  return (
    <Link
      to={`/deals/${parentDealId}`}
      data-testid="change-order-parent-link"
      title="Open the parent project deal"
      className={cn(
        "inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-brand-red",
        className
      )}
    >
      <GitBranch className="h-4 w-4" aria-hidden="true" />
      {parentLabel ? `Change order of ${parentLabel}` : "Change order — open parent deal"}
    </Link>
  );
}
