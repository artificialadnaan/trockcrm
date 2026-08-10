import type { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler.js";
import type { UserRole } from "@trock-crm/shared/types";
import { isDailyActivityLogViewerEmail } from "@trock-crm/shared/lib/dailyActivityLogViewers";
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

/**
 * The ordinary CRM role floor: every role that may reach a report surface at all.
 *
 * Exported as DATA, not only as a middleware, because more than one place has to agree on it — the guard
 * that enforces it on the route, and the session flags that tell the web client which reports it may
 * offer. A second hand-written copy of this list is precisely how the two drift, and a drift here is
 * invisible: the client offers a card whose route then bounces the user with no explanation.
 */
export const CRM_REPORT_ROLES: readonly UserRole[] = ["admin", "director", "rep"];
export const requireAnyRole = requireRole(...CRM_REPORT_ROLES);

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
 * Restrict a route to the designated Daily Activity Log viewers, resolved from DAILY_ACTIVITY_LOG_VIEWER_EMAILS.
 *
 * The log exposes the readable content of what people logged — including, for admin/director, synced email
 * BODIES — so readership is a named list rather than a role. This only NARROWS: it runs after the ordinary
 * role guard, and the service still applies its own row-scoping and its own baseRole check for email content.
 * With the env var unset it denies everyone, which is the intended failure direction for a privacy gate.
 */
export function requireDailyActivityLogViewer(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required"));
  }
  if (!isDailyActivityLogViewerEmail(req.user.email, process.env)) {
    return next(
      new AppError(
        403,
        "The Daily Activity Log is limited to designated viewers.",
        "DAILY_ACTIVITY_LOG_VIEWER_ONLY"
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
