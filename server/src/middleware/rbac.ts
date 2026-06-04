import type { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler.js";
import type { UserRole } from "@trock-crm/shared/types";
import { isRfpReviewerEmail } from "@trock-crm/shared/lib/rfpReviewerEmails";

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
