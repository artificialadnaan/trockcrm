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
 * Require admin for an OFFICE-LEVEL action, but let a GLOBAL admin through even when they hold a non-admin
 * override in the acting office. `requireAdmin` alone checks only the effective office `role`, so a global
 * admin (baseRole 'admin') who is, say, a rep in another office gets 403 when acting on that office's deal —
 * exactly the photo-share regression (#740 fixed the same shape for the user directory via requireGlobalAdmin,
 * but that swap would strip office-only admins of the action). This union keeps both: pass if the user is an
 * admin in THIS office (effective role) OR a global admin anywhere (baseRole). Absent user => 401.
 */
export function requireAdminOrGlobalAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required"));
  }
  if (req.user.role === "admin" || req.user.baseRole === "admin") {
    return next();
  }
  next(new AppError(403, "Requires one of: admin"));
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
