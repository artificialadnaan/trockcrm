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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Deals
 *
 * Two conventions inherited from Postgres that are easy to get wrong and silent when you do:
 *   - money columns are `numeric`, which serialises to a STRING ("125000.00"), never a number.
 *     Typing them as number compiles fine and then renders "NaN" on a phone.
 *   - `date` columns are "YYYY-MM-DD" strings; `timestamptz` are ISO-8601 with a Z.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Which slice of deals to list. The server coerces anything unrecognised to "mine" with a 200. */
export type DealScope = "mine" | "all" | "watched";

/**
 * At-risk is computed SERVER-side (stage age vs a per-stage threshold, with hold time excluded and
 * postponement suppression applied). Never recompute it on device — the rules have moved repeatedly and a
 * second implementation would disagree with the web app.
 */
export type AtRiskResult = {
  isAtRisk: boolean;
  status: string;
  severity: string;
  reason?: string | null;
  effectiveStageAgeDays: number | null;
  thresholdDays: number | null;
};

export type PipelineStage = {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isTerminal: boolean;
  isActivePipeline: boolean;
  color: string | null;
};

/** One row in the deals list. Narrow on purpose: tenant.deals has ~153 columns, we render a handful. */
export type DealListItem = {
  id: string;
  name: string | null;
  description: string | null;
  dealNumber: string | null;
  stageId: string | null;
  stageSlug: string | null;
  companyId: string | null;
  companyName: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  awardedAmount: string | null;
  bidEstimate: string | null;
  // Both participate in the canonical value priority — omitting them made estimating and Bid Board deals
  // display a lower value, or "—", despite having a tracked one.
  ddEstimate: string | null;
  bidBoardTotalSales: string | null;
  workflowRoute: string | null;
  expectedCloseDate: string | null;
  stageEnteredAt: string | null;
  updatedAt: string | null;
  onHold: boolean | null;
  isActive: boolean | null;
  atRisk: AtRiskResult | null;
};

export type DealListResponse = {
  deals: DealListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    activeCount: number;
    totalPages: number;
  };
};

export type DealDetail = DealListItem & {
  assignedRepId: string | null;
  assignedRepName: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  /**
   * Projected alongside `primaryContactPhone` so a mobile-only contact stays callable. The contacts
   * table carries both columns and every other contact surface coalesces them; the deal detail select
   * projected only `phone`, so a contact reachable ONLY on a mobile number showed no call action at all.
   */
  primaryContactMobile: string | null;
  propertyAddress: string | null;
  projectType: string | null;
  createdAt: string | null;
  isWatching: boolean;
};

/** One requirement the stage gate checks. `satisfied` is what the UI ticks off. */
export type ChecklistItem = {
  key: string;
  label: string;
  satisfied: boolean;
};

/**
 * The preflight verdict. This is the whole point of the two-step stage move: a rep sees exactly what is
 * missing BEFORE committing, instead of an opaque 400 after.
 */
export type StageGateResult = {
  allowed: boolean;
  isBackwardMove: boolean;
  isTerminal: boolean;
  targetStage: { id: string; name: string; slug: string };
  currentStage: { id: string; name: string; slug: string };
  missingRequirements: { fields: string[]; documents: string[]; approvals: string[] };
  effectiveChecklist: {
    fields: ChecklistItem[];
    attachments: ChecklistItem[];
    approvals: ChecklistItem[];
  };
  requiresOverride: boolean;
  blockReason: string | null;
};

/**
 * A timeline entry. The server's field names are `type` and `body` — NOT `activityType`/`notes`. Naming
 * them anything else here renders a blank timeline on a request that succeeded, which is the failure mode
 * you only notice in TestFlight.
 */
export type Activity = {
  id: string;
  dealId: string | null;
  type: string;
  subject: string | null;
  body: string | null;
  occurredAt: string | null;
  createdAt: string | null;
  performedByUserName: string | null;
  responsibleUserName: string | null;
};

export type ActivityListResponse = {
  activities: Activity[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
};
