import type { UserRole } from "./enums.js";

export interface JwtClaims {
  userId: string;
  email: string;
  officeId: string;
  role: UserRole;
  /**
   * The users.token_version current when this token was minted. Middleware rejects the token once the
   * user's version moves ahead (any deactivate/reactivate/role-change increments it). Absent on
   * pre-feature tokens → treated as 0 (the column default), so old sessions survive deploy but are
   * invalidated the first time that user is acted on.
   */
  tokenVersion?: number;
  authMethod?: "local" | "dev";
  // Token audience/surface. Tokens minted for the FIELD app (T-Rock Cam / client-field) carry
  // surface:"field"; the WEB CRM/admin leaves it unset; the native CRM app (mobile-crm) carries
  // surface:"mobile". CRM auth (authMiddleware) REJECTS any token with surface:"field" regardless of the
  // user's current role — so a long-lived field token can never be replayed against CRM routes, even if
  // the user is later promoted. (Field routes accept it normally.)
  //
  // That guard is a FIELD-ONLY DENYLIST (`=== "field"`), not an allowlist, so surface-less web tokens and
  // surface:"mobile" both pass CRM auth by design — which is exactly why adding "mobile" here needs no
  // middleware change. Read "mobile" as a provenance/audit LABEL, not a privilege boundary: a mobile
  // token is precisely as powerful as a web CRM token for the same user.
  surface?: "field" | "mobile";
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  /**
   * The user's HOME role from users.role — NEVER elevated by a per-office role_override. `role` above
   * is the EFFECTIVE role (override-aware) used for office-scoped work; `baseRole` is the global-trust
   * role that global-admin gating (requireGlobalAdmin) MUST use, so an office-scoped admin override can
   * never reach global-admin endpoints (e.g. user provisioning, which creates GLOBAL accounts).
   */
  baseRole?: UserRole;
  officeId: string;
  activeOfficeId: string; // May differ from officeId if user switched offices
  mustChangePassword?: boolean;
  authMethod?: "local" | "dev";
  onboardingCompletedAt?: string | null;
  onboardingPendingCount?: number;
  requiresOnboarding?: boolean;
  cleanupUrl?: string;
  /** True iff this user is a designated RFP override reviewer (RFP_REJECTION_EMAIL_RECIPIENTS allowlist). */
  isRfpReviewer?: boolean;
  /** True iff this user is one of the 3 RFP voters (RFP_VOTER_EMAILS allowlist); gates the vote UI + /rfp-vote page. */
  isRfpVoter?: boolean;
}
