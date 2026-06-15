import type { UserRole } from "./enums.js";

export interface JwtClaims {
  userId: string;
  email: string;
  officeId: string;
  role: UserRole;
  authMethod?: "local" | "dev";
  // Token audience/surface. Tokens minted for the FIELD app (T-Rock Cam / client-field) carry
  // surface:"field"; CRM/admin tokens leave it unset. CRM auth (authMiddleware) REJECTS any token with
  // surface:"field" regardless of the user's current role — so a long-lived field token can never be
  // replayed against CRM routes, even if the user is later promoted. (Field routes accept it normally.)
  surface?: "field";
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
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
}
