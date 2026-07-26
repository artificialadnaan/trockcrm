/**
 * CRM entity types, hand-mirrored from the server.
 *
 * mobile-crm sits OUTSIDE the npm workspace graph on purpose (see metro.config.js), so it cannot import
 * @trock-crm/shared. T-Rock Cam mirrors its types the same way. The tradeoff is deliberate: a workspace
 * membership that let us import shared types would break Metro's resolution, expo-doctor, and standalone
 * EAS builds. Keep these narrow — mirror only the fields the app actually reads, so server-side additions
 * don't force churn here.
 */

/** Roles that may use the CRM app. Mirrors the server's requireCrmUser boundary. */
export type CrmUserRole = "admin" | "director" | "rep" | "construction";

/**
 * The user object returned by POST /api/auth/mobile-login, which is withOnboardingGate()'s output.
 *
 * `isRfpVoter` / `isRfpReviewer` come from an EMAIL ALLOWLIST on the server (RFP_VOTER_EMAILS /
 * RFP_REJECTION_EMAIL_RECIPIENTS), not from the role — which is why they arrive as booleans rather than
 * being derivable client-side. They gate which screens are shown; the server endpoints enforce the same
 * allowlist as the hard boundary, so hiding a screen is a courtesy, never the security control.
 */
export type CrmUser = {
  id: string;
  email: string;
  displayName: string;
  role: CrmUserRole;
  officeId: string;
  activeOfficeId?: string;
  /**
   * True when the user must set a new password before doing anything else. The server 403s every route
   * except /api/auth/me, /api/auth/logout and /api/auth/local/change-password while this is set, so the
   * app must route to the change-password screen rather than land on the dashboard.
   */
  mustChangePassword?: boolean;
  /**
   * True while the user still has pending migration-cleanup items (auth/service.ts:130). Unlike
   * mustChangePassword this is NOT enforced server-side — CRM endpoints answer normally — so a client
   * that ignores it does not get errors, it gets full access, and becomes the way around the gate.
   */
  requiresOnboarding?: boolean;
  onboardingPendingCount?: number;
  /** Where the cleanup workspace lives. Absent in some deployments, so the button is conditional. */
  cleanupUrl?: string;
  isRfpVoter?: boolean;
  isRfpReviewer?: boolean;
};

export type MobileLoginResponse = {
  token: string;
  user: CrmUser;
};

/** One office the signed-in user may switch into. From GET /api/auth/accessible-offices. */
export type AccessibleOffice = {
  id: string;
  name: string;
  slug?: string;
};
