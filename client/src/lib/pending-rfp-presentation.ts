import { AlertTriangle, Clock, XCircle } from "lucide-react";
import { pendingRfpSubStateForStatus } from "@trock-crm/shared/types";

/**
 * ONE status -> presentation map for the Pending RFP bucket, shared by the `/deals/pending-rfp` queue
 * and the `/deals` board card.
 *
 * Both surfaces used to decide label + colour independently (the page inline, the card not at all), and
 * the first draft of the board work "reused" the page's colours by eye and got two of the three
 * attention statuses wrong — conflict is amber and send_failed is red, not one shade of rose. This map
 * is the fix: the LABEL and the TONE live here once, so the two surfaces cannot drift.
 *
 * It returns a tone KEY, not Tailwind classes, because the two consumers legitimately render different
 * shapes — the page a ring-outlined pill, the card a dense uppercase chip plus a top accent bar. Each
 * owns its own tone -> class table; what must agree (which status is which colour family, and what it is
 * called) is what lives here. It stays in client/ rather than shared/ because both consumers are
 * client-side and shared/ has no business carrying CSS.
 */
export type PendingRfpTone = "sky" | "rose" | "amber" | "red";

export interface PendingRfpPresentation {
  label: string;
  tone: PendingRfpTone;
  Icon: typeof Clock;
}

/** Presentation for any Pending RFP status; null for a status outside the bucket (incl. null/approved). */
export function pendingRfpPresentation(
  status: string | null | undefined
): PendingRfpPresentation | null {
  const subState = pendingRfpSubStateForStatus(status);
  if (subState === null) return null;
  if (subState === "awaiting") {
    return { label: "Awaiting approval", tone: "sky", Icon: Clock };
  }
  switch (status) {
    case "declined":
      return { label: "Declined", tone: "rose", Icon: XCircle };
    case "conflict":
      return { label: "Conflict", tone: "amber", Icon: AlertTriangle };
    case "send_failed":
      return { label: "Send failed", tone: "red", Icon: AlertTriangle };
    default:
      // Unreachable while PENDING_RFP_ATTENTION_STATUSES is those three, but a new attention status must
      // degrade to a labelled chip rather than vanishing off the board.
      return { label: "Needs attention", tone: "amber", Icon: AlertTriangle };
  }
}

/**
 * Attention-only view of the map: null for an AWAITING deal as well as for a non-bucket status.
 *
 * The board marks only the deals that need someone to act. Marking every card in the column would mark
 * 27 of 27 — membership already requires a sub-state — and a uniformly striped column carries no signal.
 * The parked majority is left plain on purpose; that is what makes the marked minority visible.
 */
export function pendingRfpAttentionPresentation(
  status: string | null | undefined
): PendingRfpPresentation | null {
  if (pendingRfpSubStateForStatus(status) !== "attention") return null;
  return pendingRfpPresentation(status);
}
