import { isGenuineWonDealStageSlug, isOpportunityStageSlug } from "./workflow.js";
import type { WorkflowRoute } from "./enums.js";

/**
 * "Move back to Opportunity" — every eligibility and permission DECISION for the action, as pure
 * functions. Server (route + service) and client (menu item + dialog) both call these so they cannot
 * drift: a client that thinks the button is enabled and a server that 403s is the failure mode this
 * module exists to make impossible.
 *
 * Wiring (who calls this, and with what) lives in the server service / client page; only the rules
 * live here. This mirrors the userProvisioningGuards.ts pattern from PR #740.
 */

export const RETURN_TO_OPPORTUNITY_BLOCK_CODES = [
  "ALREADY_OPPORTUNITY",
  "DEAL_INACTIVE",
  "CHANGE_ORDER",
  "HAS_CHANGE_ORDERS",
  "ROLE_NOT_ALLOWED",
  "COMMISSION_ROLE_NOT_ALLOWED",
] as const;

export type ReturnToOpportunityBlockCode = (typeof RETURN_TO_OPPORTUNITY_BLOCK_CODES)[number];

export interface ReturnToOpportunityDealState {
  /** Raw pipeline_stage_config slug of the deal's CURRENT stage (not canonicalized). */
  stageSlug: string | null | undefined;
  workflowRoute: WorkflowRoute;
  isActive: boolean;
  isChangeOrder: boolean;
  /** Count of ACTIVE change-order CHILD deals hanging off this deal. */
  activeChangeOrderCount: number;
  /** Number of deal_signed_commissions rows booked against the deal. */
  commissionRowCount: number;
  /** Sum of those rows, as a decimal string ("0" when there are none). */
  commissionTotal: string;
  /** contract_signed_date / contract_signed_at, collapsed to a single effective date by the caller. */
  effectiveContractSignedDate: string | null;
}

export interface ReturnToOpportunityEligibility {
  allowed: boolean;
  blockCode: ReturnToOpportunityBlockCode | null;
  blockReason: string | null;
  /** True when committing the move will DELETE booked commission rows and/or clear the signed date. */
  voidsCommission: boolean;
  commissionRowCount: number;
  commissionTotal: string;
  /** True when the deal sits in a genuine Won-family stage today. */
  isWonFamily: boolean;
  /** The minimum role that may perform THIS move (widens/narrows with voidsCommission). */
  requiredRole: "admin" | "director";
}

/** Roles that may move an ordinary (no booked money) deal back to Opportunity. */
export const RETURN_TO_OPPORTUNITY_ROLES = ["admin", "director"] as const;
/** Roles that may perform the money-destroying variant (booked commission and/or a signed contract). */
export const RETURN_TO_OPPORTUNITY_COMMISSION_ROLES = ["admin"] as const;

function isAllowedRole(role: string | null | undefined, allowed: readonly string[]): boolean {
  return role != null && allowed.includes(role);
}

/**
 * Decide whether `role` may move this deal back to Opportunity, and what it will cost.
 *
 * PERMISSIONS (two tiers, both narrower-or-equal to what the role can already do today):
 *  • ordinary move → admin + director. This IS a backward stage move, and validateStageGate already
 *    refuses backward moves for reps ("Reps cannot move deals backward. A director must perform this
 *    action."), so the button grants nobody a new privilege — it just makes the director's existing
 *    capability actually STICK by severing the Bid Board link. It also obliges the operator to delete
 *    the project from Bid Board by hand, which reps generally cannot do.
 *  • the move voids booked commission (Won-family, or any deal carrying commission rows / an effective
 *    contract-signed date) → admin ONLY. A director can still reach the same end state through the
 *    existing two-step accounting lever (clear the contract-signed date, which runs
 *    removeCommissionForDeal, then move the deal back), so no capability is removed — only the
 *    one-click form of it is restricted, because one click that silently deletes earned commission is
 *    a different risk from a deliberate accounting correction.
 *
 * BLOCKS (not permission, correctness):
 *  • already at Opportunity — nothing to do, and running the detach anyway would clear a live RFP cycle.
 *  • a change order itself — a CO is a Won child that must never change stage (changeDealStage rejects
 *    it too); moving one would silently drop its value out of every Won report.
 *  • a deal with ACTIVE change-order children — the children stay Won with their own commission rows
 *    under an Opportunity parent. Voiding them implicitly would destroy money the operator never saw
 *    named in the dialog, so the parent move is refused until the COs are deleted through the
 *    change-order endpoint (which voids their commission with its own audit trail).
 */
export function evaluateReturnToOpportunityEligibility(
  deal: ReturnToOpportunityDealState,
  role: string | null | undefined
): ReturnToOpportunityEligibility {
  const isWonFamily = isGenuineWonDealStageSlug(deal.stageSlug, deal.workflowRoute);
  // "Voids commission" is deliberately broader than "is Won": a deal can carry booked
  // deal_signed_commissions rows or a contract-signed date at ANY stage (the signed date is ungated,
  // and the Bid Board can move a signed deal backward), and those are exactly the rows/dates this
  // action destroys. Keying the gate on the stage alone would let the destructive variant through
  // the ordinary permission tier.
  const voidsCommission =
    isWonFamily || deal.commissionRowCount > 0 || deal.effectiveContractSignedDate != null;

  const base = {
    voidsCommission,
    commissionRowCount: deal.commissionRowCount,
    commissionTotal: deal.commissionTotal,
    isWonFamily,
    requiredRole: (voidsCommission ? "admin" : "director") as "admin" | "director",
  };

  if (!deal.isActive) {
    return {
      ...base,
      allowed: false,
      blockCode: "DEAL_INACTIVE",
      blockReason: "This deal is archived. Restore it before moving it back to Opportunity.",
    };
  }

  if (deal.isChangeOrder) {
    return {
      ...base,
      allowed: false,
      blockCode: "CHANGE_ORDER",
      blockReason:
        "A change order is a Won child deal and cannot change stage. Delete the change order instead.",
    };
  }

  if (isOpportunityStageSlug(deal.stageSlug)) {
    return {
      ...base,
      allowed: false,
      blockCode: "ALREADY_OPPORTUNITY",
      blockReason: "This deal is already in Opportunity.",
    };
  }

  if (deal.activeChangeOrderCount > 0) {
    return {
      ...base,
      allowed: false,
      blockCode: "HAS_CHANGE_ORDERS",
      blockReason:
        `This deal has ${deal.activeChangeOrderCount} change order${deal.activeChangeOrderCount === 1 ? "" : "s"}. ` +
        "Delete them first — a change order stays Won (with its own commission) and cannot hang off an Opportunity.",
    };
  }

  if (voidsCommission) {
    if (!isAllowedRole(role, RETURN_TO_OPPORTUNITY_COMMISSION_ROLES)) {
      return {
        ...base,
        allowed: false,
        blockCode: "COMMISSION_ROLE_NOT_ALLOWED",
        blockReason:
          "This deal has booked commission or a signed contract, so only an admin can move it back to Opportunity.",
      };
    }
  } else if (!isAllowedRole(role, RETURN_TO_OPPORTUNITY_ROLES)) {
    return {
      ...base,
      allowed: false,
      blockCode: "ROLE_NOT_ALLOWED",
      blockReason: "Only a director or an admin can move a deal back to Opportunity.",
    };
  }

  return { ...base, allowed: true, blockCode: null, blockReason: null };
}

/**
 * Normalize a money total to a comparable string so the client's "I showed the user $X" acknowledgement
 * can be compared against the server's live sum without decimal-formatting false mismatches
 * ("1200" / "1200.00" / "1,200.00" / "$1,200.00" all collapse to the same key).
 */
export function commissionAckKey(value: string | number | null | undefined): string {
  if (value == null || value === "") return "0";
  const cleaned = String(value).replace(/[$,\s]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return "0";
  // 2dp: deal_signed_commissions.amount is numeric(14,2), so anything finer is noise.
  return parsed.toFixed(2);
}
