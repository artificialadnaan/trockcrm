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
/**
 * The server's at-risk verdict. `status` and `severity` are typed as OPEN unions — the known values,
 * plus `(string & {})` so an unrecognised one still assigns.
 *
 * Deliberately not a closed union: this app cannot import the server's enum (see the header note), so a
 * closed list would be a hand-copy that silently starts lying the moment a value is added server-side.
 * Open unions give autocomplete and catch typos in comparisons — which is what actually goes wrong here
 * — without pretending to know the full set.
 */
export type AtRiskStatus = "at_risk" | "ok" | "postponed" | "suppressed" | (string & {});
export type AtRiskSeverity = "none" | "low" | "medium" | "high" | (string & {});

export type AtRiskResult = {
  isAtRisk: boolean;
  status: AtRiskStatus;
  severity: AtRiskSeverity;
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
  /**
   * Which workflow this stage belongs to. `GET /deals/stages` returns BOTH deal families in one
   * unfiltered list, so without this a service-only stage is indistinguishable from a standard one and
   * gets offered to every deal. See eligibleStageTargets in src/stage-targets.ts.
   */
  workflowFamily: "standard_deal" | "service_deal" | "lead" | null;
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
  /**
   * A change order is a Won CHILD deal, and the stage-change route rejects one unconditionally with a
   * 409 CHANGE_ORDER_STAGE_LOCKED (stage-change.ts:161-167) — moving it off Won would silently drop its
   * value from every Won report. Preflight does NOT apply that lock, so without this field the app can
   * show a green "Ready to move" and then fail on commit.
   */
  isChangeOrder: boolean | null;
  atRisk: AtRiskResult | null;
  /**
   * SERVER verdicts. Do not recompute either of these on device.
   *
   * "Effectively on hold" is not just the stored `on_hold` flag: it ORs in a close target more than 90
   * calendar days out, exempts terminal deals, and resolves "today" against the America/Chicago calendar
   * day. `effectiveValue` is the canonical four-column value with that hold rule applied — a held deal is
   * worth 0. Deriving this locally would be a second implementation of a rule that has moved repeatedly,
   * and its failure mode is wrong money beside an On Hold badge, not an error. See attachAtRiskResult.
   */
  effectiveOnHold: boolean | null;
  effectiveValue: number | null;
  /**
   * OPTIONAL because it is not on every shape: pipeline board cards and the deal detail carry it, the
   * plain /deals list row does not. It decides whether a stage move is offered at all, so a type that
   * claimed it was always present would invite gating on `undefined === userId` — permanently false,
   * silently hiding the action from the one person allowed to take it.
   */
  assignedRepId?: string | null;
  /**
   * The stage to DISPLAY. A Bid Board-owned deal can advance, or close, in Bid Board while its CRM
   * `stageSlug` still reads an earlier stage; the web detail already switches to bidBoardStageSlug.
   */
  displayStageSlug: string | null;
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

/**
 * Present on pipeline BOARD cards and the deal detail, absent from the plain list. Ownership decides
 * whether a stage move is even offered — the commit route is strictly owner-only.
 */
export type DealOwnership = { assignedRepId: string | null };

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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Contacts and companies
 *
 * The server exposes THREE different shapes for a single contact, and they are not interchangeable:
 *   GET /contacts        list rows   — carry ownerUserName, isPrimary, linkedDealsCount, lastTouchAt
 *   GET /contacts/:id    detail row  — DOES NOT carry any owner field at all
 *   POST/PATCH responses raw row     — carry ownerId, but none of the computed/joined fields
 * Modelling them as one type would make `owner` look available on a screen where it is always
 * undefined. They are kept separate deliberately.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Required on create. snake_case tokens; see CONTACT_CATEGORY_LABELS for display. */
export type ContactCategory =
  | "client"
  | "subcontractor"
  | "architect"
  | "property_manager"
  | "regional_manager"
  | "vendor"
  | "consultant"
  | "influencer"
  | "other";

type ContactBase = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  jobTitle: string | null;
  category: ContactCategory | string;
  role: string | null;
  city: string | null;
  state: string | null;
  companyId: string | null;
  /** Free text, often null or stale on imported contacts — prefer linkedCompanyName. */
  companyName: string | null;
  isActive: boolean | null;
};

/** A row from GET /contacts. */
export type ContactListRow = ContactBase & {
  linkedCompanyName: string | null;
  ownerUserName: string | null;
  isPrimary: boolean;
  linkedDealsCount: number;
  lastTouchAt: string | null;
};

/** A row from GET /contacts/:id. Note the ABSENCE of owner fields — the endpoint does not select them. */
export type ContactDetail = ContactBase & {
  /**
   * Soft-delete flag. The DIRECTORY filters to active contacts, but getContactById
   * (contacts/service.ts:571-572) selects by id alone with no isActive predicate — so a contact
   * soft-deleted or merged after this screen was cached, or reached by deep link, still comes back.
   * The screen has to check it; the server will not.
   */
  isActive: boolean | null;
  linkedCompanyName: string | null;
  isPrimary: boolean;
  linkedDealsCount: number;
  lastTouchAt: string | null;
  address: string | null;
  zip: string | null;
  notes: string | null;
  lastContactedAt: string | null;
};

export type ContactListResponse = {
  contacts: ContactListRow[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
};

/**
 * The deal carried by a contact association is the RAW tenant.deals row (passed through
 * redactDealResponse), NOT a list row: contacts/association-service.ts:26-34 selects `deals` whole with
 * no joins and no derived fields. So there is no `stageSlug`, no server `atRisk` verdict, and none of the
 * joined company/property columns a DealListItem promises. Typing it as DealListItem invited code to read
 * fields that are always undefined — and undefined renders as a blank, not as an error.
 */
export type AssociatedDeal = {
  id: string;
  name: string | null;
  /**
   * Soft-delete flag. An explicit `false` means deleted and must not be shown or opened.
   *
   * OPTIONAL, matching what getContactDeals actually accepts: it filters on `isActive !== false`, so an
   * older row that predates the column — or a redaction that drops it — stays VISIBLE. Requiring it here
   * told callers the field is always present, which is the assumption that filter exists to avoid.
   */
  isActive?: boolean | null;
  stageId: string | null;
  onHold: boolean | null;
  workflowRoute: string | null;
  expectedCloseDate: string | null;
  awardedAmount: string | null;
  bidEstimate: string | null;
  ddEstimate: string | null;
  bidBoardTotalSales: string | null;
};

/** GET /contacts/:id/deals returns associations, each wrapping the deal — not a bare deal list. */
export type ContactDealAssociation = {
  id: string;
  role?: string | null;
  deal: AssociatedDeal | null;
};

/**
 * A lead row as the LIST returns it.
 *
 * Narrow on purpose, same reasoning as DealListItem: the server sends every column of tenant.leads via
 * getTableColumns(leads) plus a decoration pass, and a phone renders a handful.
 *
 * `projectType` is an OBJECT here and a STRING on writes. The list decorator resolves the id against
 * projectTypeMap and attaches the row (service.ts:702), while POST/PATCH take `projectTypeId`. Reading
 * this as a name renders "[object Object]"; sending it back as one is a 400.
 */
export type LeadListItem = {
  id: string;
  name: string | null;
  stageId: string | null;
  stageName: string | null;
  status: string | null;
  isActive: boolean | null;
  assignedRepId: string | null;
  assignedRepName: string | null;
  companyId: string | null;
  companyName: string | null;
  primaryContactName: string | null;
  primaryContactTitle: string | null;
  projectTypeId: string | null;
  projectType: { id: string; name: string } | null;
  property: { id: string; name: string | null; address: string | null; city: string | null; state: string | null } | null;
  estimatedValue: string | number | null;
  /**
   * THREE source columns, and which one is populated depends on a server flag.
   *
   * Under lead-edit-v2 a lead's source is written to sourceCategory/sourceDetail and the legacy `source`
   * column is deliberately left null — so reading `source` alone shows "—" for every lead created since
   * that flag went on, despite the record plainly having a source.
   */
  source: string | null;
  sourceCategory: string | null;
  sourceDetail: string | null;
  /** The outcome-aware display axis the server also FILTERS on — already YYYY-MM-DD or null. */
  displayDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Lifecycle timestamps. The DETAIL response has these; it does not have the list's `displayDate`. */
  convertedAt?: string | null;
  disqualifiedAt?: string | null;
  stageEnteredAt?: string | null;
  /** Set once the lead has been converted; the pair is how a converted lead links to its deal. */
  convertedDealId: string | null;
  convertedDealNumber: string | null;
};

/** The detail read adds these on top of the list shape. */
export type LeadDetail = LeadListItem & {
  isWatching?: boolean;
  description?: string | null;
  notes?: string | null;
  expectedCloseDate?: string | null;
  /**
   * ONLY present when the server's lead-edit-v2 flag is on (leads/routes.ts:289-305). Its absence is a
   * server configuration, not an error and not an empty questionnaire — rendering "no questions" for it
   * would state something this client cannot know.
   */
  leadQuestionnaire?: unknown;
};

/** A lead-family pipeline stage. Same table as deal stages, different workflow family. */
export type LeadStage = {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isTerminal: boolean;
  isActivePipeline: boolean;
  workflowFamily: string | null;
  color: string | null;
};

/**
 * The stage-transition result. THE RESULT IS THE BODY — there is no envelope — and a refusal arrives as
 * HTTP 409 carrying this same shape (leads/routes.ts:539).
 */
export type LeadTransitionRefusal = {
  ok: false;
  reason: string;
  code?: string | null;
  targetStageId?: string | null;
  /** Where the WHOLE transition must be resolved when the per-field hints are not enough. */
  resolution?: "detail" | "inline" | null;
  /** What the lead still needs. Each entry says whether it can be fixed inline or only on the record. */
  missing?: Array<{ key: string; label: string; resolution: "detail" | "inline" }>;
};

export type LeadTransitionResult = { ok: true; lead: LeadDetail } | LeadTransitionRefusal;
