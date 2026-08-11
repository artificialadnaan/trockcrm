import type { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler.js";
import type { UserRole } from "@trock-crm/shared/types";
import { isDealMoveBackApproverEmail } from "@trock-crm/shared/lib/dealMoveBackApprovers";
import { isRfpReviewerEmail } from "@trock-crm/shared/lib/rfpReviewerEmails";
import { isRfpVoterEmail } from "@trock-crm/shared/lib/rfpVoterEmails";

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, "Authentication required"));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(403, `Requires one of: ${allowedRoles.join(", ")}`)
      );
    }

    next();
  };
}

export const requireAdmin = requireRole("admin");
export const requireDirector = requireRole("admin", "director");
export const requireAnyRole = requireRole("admin", "director", "rep");

/**
 * Require GLOBAL admin — the user's HOME role (`baseRole`), NOT the effective office role. `requireAdmin`
 * checks the effective `role`, which authMiddleware rewrites from a per-office `role_override`; that lets
 * an office-scoped admin override pass it. Endpoints that act on the GLOBAL account directory (user
 * provisioning, role/active changes) must use this so an office override can't escalate to global admin
 * (#740). `baseRole` is set by authMiddleware on every CRM request; absent => deny.
 */
export function requireGlobalAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required"));
  }
  if (req.user.baseRole !== "admin") {
    return next(new AppError(403, "Global admin required"));
  }
  next();
}

/**
 * Restrict a route to the designated RFP override reviewers — exactly the leadership recipients of the
 * RFP-decline email (Takashi + Adam Shaw), resolved from RFP_REJECTION_EMAIL_RECIPIENTS. This is the SAME
 * source of truth as who gets notified, so the reviewer set and the notified set never drift. A regular
 * admin/director who is not on that list gets 403 — role does NOT grant override rights.
 */
export function requireRfpReviewer(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required"));
  }
  if (!isRfpReviewerEmail(req.user.email, process.env)) {
    return next(
      new AppError(
        403,
        "Only the designated RFP reviewers can review declined RFPs.",
        "RFP_REVIEWER_ONLY"
      )
    );
  }
  next();
}

/**
 * Restrict a route to the designated move-back approvers (DEAL_MOVE_BACK_APPROVER_EMAILS).
 *
 * Moving a deal back to Opportunity severs Bid Board sync, retires the RFP cycle and VOIDS booked
 * commission — none of it reversible by moving the deal forward again. Every admin and director can make
 * ordinary backward stage moves; this one destroys money, so it is a named list rather than a role.
 *
 * Only ever narrows: requireRole runs first, and the service still applies its own eligibility rules,
 * including the admin-only narrowing when commission is at stake. With the env var unset nobody may do it,
 * which for a NEW capability means it is simply unavailable rather than something being taken away.
 */
export function requireDealMoveBackApprover(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required"));
  }
  if (!isDealMoveBackApproverEmail(req.user.email, process.env)) {
    return next(
      new AppError(
        403,
        "Moving a deal back to Opportunity is limited to designated approvers.",
        "DEAL_MOVE_BACK_APPROVER_ONLY"
      )
    );
  }
  next();
}

/**
 * Restrict a route to the 3 designated RFP voters (Sidney/Tim/James), resolved from RFP_VOTER_EMAILS.
 * This is the SAME source of truth as who is invited to vote, so the eligible set and the invited set
 * never drift. A regular admin/director who is not on that list gets 403 — role does NOT grant vote
 * rights. Mirrors requireRfpReviewer.
 */
export function requireRfpVoter(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required"));
  }
  if (!isRfpVoterEmail(req.user.email, process.env)) {
    return next(
      new AppError(
        403,
        "Only the designated RFP voters can vote on RFPs.",
        "RFP_VOTER_ONLY",
      )
    );
  }
  next();
}
