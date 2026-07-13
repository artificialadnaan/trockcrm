import { and, asc, desc, eq, getTableColumns, ilike, inArray, or, sql, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  CANONICAL_LEAD_STAGE_SLUGS,
  activities,
  companies,
  contacts,
  deals,
  leadDueDiligenceApprovals,
  leadStageHistory,
  leadQuestionAnswers,
  leads,
  pipelineStageConfig,
  projectTypeConfig,
  properties,
  offices,
  tasks,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  toCanonicalLeadStageSlug,
  resolveOfficeCodeFromOffice,
  type UserRole,
  type WorkflowFamily,
} from "@trock-crm/shared/types";
import { db } from "../../db.js";
import { buildLeadSearchCondition, escapeLikePattern } from "../search/unified-search.js";
import { AppError } from "../../middleware/error-handler.js";
import { isCrmUserRole } from "../../middleware/field-auth.js";
import { createAssignmentTaskIfNeeded } from "../assignment-tasks/service.js";
import { getActiveProjectTypes, getAllStages, getStageById, getStageBySlug } from "../pipeline/service.js";
import { assertLeadStageTransitionAllowed, LeadStageTransitionError } from "./stage-transition-service.js";
import { preflightLeadStageCheck } from "./stage-gate.js";
import {
  evaluateLeadQuestionGate,
  isAnsweredQuestionValue,
  isLeadEditV2Enabled,
  listQuestionnaireNodes,
  type LeadQuestionAnswerValue,
  upsertLeadQuestionAnswerSet,
} from "./questionnaire-service.js";
import {
  computeExistingCustomerStatus,
} from "../companies/customer-status-service.js";
import {
  createLeadDueDiligenceApproval,
} from "./due-diligence-service.js";
import { isExistingCustomer } from "./verification-service.js";
import { resolveLeadSourceForWrite } from "./source-control.js";
import { resolveActiveOfficeUserIds, resolveTeamRepIds } from "../shared/team-scope.js";
import {
  buildLeadOutcomeDateScope,
  leadDisplayDateExpr,
} from "../shared/lead-date-scope.js";
import {
  buildAliasedLeadMineVisibilityCondition,
  buildLeadMineVisibilityCondition,
  resolveMineVisibilityFeatures,
} from "../shared/mine-visibility.js";
import {
  LEAD_BUDGET_STATUSES,
  LEAD_POC_ROLES,
  type LeadBudgetStatus,
  type LeadPocRole,
  type LeadSourceCategory,
} from "@trock-crm/shared/types";
import { logActivity, type AuditContext } from "../audit/audit-logger.js";
import { buildArchivedDescription } from "../deals/archive-description.js";

type TenantDb = NodePgDatabase<typeof schema>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, fieldName: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new AppError(400, `${fieldName} must be a valid UUID`);
  }
  return normalized;
}

export interface LeadFilters {
  search?: string;
  companyId?: string;
  propertyId?: string;
  assignedRepId?: string;
  projectTypeId?: string;
  /**
   * Stage filter values. The leads FilterBar emits CANONICAL board-stage ids
   * (`column.stage.id`), each of which is expanded server-side to its alias-stage
   * family (resolveLeadStageBucketIds); a non-canonical stage id still matches
   * itself. Sent as a CSV by the client.
   */
  stageIds?: string[];
  status?: "open" | "converted" | "disqualified";
  isActive?: boolean | "all";
  createdFrom?: string;
  createdTo?: string;
  /**
   * Outcome-aware date window (FilterBar Wave 1): converted -> converted_at,
   * disqualified -> disqualified_at, open -> stage-entry (fallback created_at),
   * resolved by the shared lead-date-scope predicate. Distinct from
   * createdFrom/createdTo, which always window on created_at.
   */
  dateFrom?: string;
  dateTo?: string;
  sortBy?: "created_at" | "updated_at";
  sortDir?: "asc" | "desc";
  scope?: WorkspaceScope;
  activeOfficeId?: string;
  /**
   * Row cap for the flat list (FilterBar). listLeads is NOT offset-paginated yet, so without a LIMIT the
   * full-list FilterBar surface would fetch every active+converted+disqualified lead on a large tenant
   * (Codex #577 P2). Clamped to [1, LEADS_LIST_MAX_ROWS]; defaults to the max when omitted.
   */
  limit?: number;
}

/** Hard ceiling for the flat lead list (mirrors the client's LEADS_LIST_PAGE_SIZE). */
export const LEADS_LIST_MAX_ROWS = 100;

/** UUID shape guard — used so a malformed id no-matches instead of erroring a uuid cast. */
const LEAD_FILTER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateLeadInput {
  companyId: string;
  propertyId: string;
  stageId?: string;
  assignedRepId: string;
  actorUserId?: string;
  salesRepId?: string | null;
  officeId?: string;
  primaryContactId?: string | null;
  primaryContactRole?: LeadPocRole | null;
  primaryContactRoleOtherLabel?: string | null;
  name: string;
  source?: string;
  sourceCategory?: LeadSourceCategory | null;
  sourceDetail?: string | null;
  description?: string;
  officeCode: string;
  projectType?: string | null;
  projectTypeId?: string | null;
  bidDueDate?: string | null;
  budgetStatus?: LeadBudgetStatus | null;
  qualificationPayload?: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  leadQuestionAnswers?: Record<string, string | boolean | number | null>;
  auditContext?: AuditContext;
}

export interface UpdateLeadInput {
  stageId?: string;
  assignedRepId?: string;
  salesRepId?: string | null;
  officeId?: string;
  primaryContactId?: string | null;
  name?: string;
  source?: string | null;
  sourceCategory?: LeadSourceCategory | null;
  sourceDetail?: string | null;
  description?: string | null;
  officeCode?: string | null;
  office?: "dfw" | "atl" | null;
  projectType?: string | null;
  projectTypeId?: string | null;
  bidDueDate?: string | null;
  qualificationPayload?: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  leadQuestionAnswers?: Record<string, string | boolean | number | null>;
  status?: "open" | "disqualified";
  auditContext?: AuditContext;
}

interface LeadServiceDependencies {
  getAllStages: (workflowFamily?: WorkflowFamily) => Promise<Array<{
    id: string;
    name?: string;
    slug: string;
    displayOrder: number;
    isTerminal: boolean;
    isActivePipeline?: boolean;
  }>>;
  getStageById: (id: string, workflowFamily?: WorkflowFamily) => Promise<{
    id: string;
    name?: string;
    slug?: string;
    displayOrder?: number;
    isTerminal: boolean;
  } | null>;
  getStageBySlug: (slug: string, workflowFamily?: WorkflowFamily) => Promise<{
    id: string;
    name?: string;
    slug?: string;
    displayOrder?: number;
    isTerminal: boolean;
  } | null>;
  getActiveProjectTypes: typeof getActiveProjectTypes;
  now: () => Date;
}

const defaultDependencies: LeadServiceDependencies = {
  getAllStages,
  getStageById,
  getStageBySlug,
  getActiveProjectTypes,
  now: () => new Date(),
};

const CANONICAL_LEAD_STAGE_INDEX = new Map(
  CANONICAL_LEAD_STAGE_SLUGS.map((stageSlug, index) => [stageSlug, index] as const)
);

interface TransitionLeadStageInput {
  leadId: string;
  targetStageId: string;
  userId: string;
  userRole: string;
  officeId?: string;
  inlinePatch?: Partial<UpdateLeadInput>;
  auditContext?: AuditContext;
}

type TransitionBlockedResult = {
  ok: false;
  reason: "missing_requirements";
  code?: string;
  targetStageId: string;
  resolution: "inline" | "detail";
  missing: Array<{
    key: string;
    label: string;
    resolution: "inline" | "detail";
  }>;
};

type TransitionSuccessResult = {
  ok: true;
  lead: Record<string, unknown>;
};

type WorkspaceScope = "mine" | "team" | "all";

const LEAD_BUDGET_STATUS_VALUES = new Set<LeadBudgetStatus>(LEAD_BUDGET_STATUSES);

async function resolveActiveOfficeScope(tenantDb: TenantDb, activeOfficeId: string) {
  const [office, officeUserIds] = await Promise.all([
    db
      .select({ slug: offices.slug, name: offices.name })
      .from(offices)
      .where(eq(offices.id, activeOfficeId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    resolveActiveOfficeUserIds(tenantDb, activeOfficeId),
  ]);

  return {
    activeOfficeId,
    officeCode: resolveOfficeCodeFromOffice(office),
    officeUserIds,
  };
}

export function buildLeadOfficeScopeCondition(
  _alias: string,
  _input: { activeOfficeId: string; officeCode: string | null; officeUserIds: string[] }
) {
  // office_code is a cosmetic project-number prefix, NOT an access boundary. Leads are scoped by the
  // active-office SCHEMA (search_path) alone, so the lead list shows every lead in the schema regardless
  // of office_code — e.g. an ATL-prefixed lead created on the Dallas schema stays visible to the Dallas
  // reps who created it. (Signature/call sites kept unchanged; the scope inputs are intentionally unused
  // now.) Mine/team visibility is applied by a SEPARATE condition and is unaffected by this change.
  return sql`true`;
}

const LEAD_POC_ROLE_VALUES = new Set<LeadPocRole>(LEAD_POC_ROLES);

const CREATE_GATE_FIELD_LABELS = new Map<string, string>([
  ["property.address", "Project address"],
  ["property.city", "Project city"],
  ["property.state", "Project state"],
  ["property.zip", "Project ZIP"],
  ["property.buildYear", "Year built"],
  ["property.unitCount", "Number of units"],
  ["primaryContactId", "Point of contact"],
  ["primaryContactRole", "POC role"],
  ["primaryContactRoleOtherLabel", "POC role other label"],
  ["budgetStatus", "Budget status"],
  ["projectTypeId", "Project type"],
  ["bidDueDate", "Bid Due Date"],
]);

export class LeadCreateRequirementsError extends Error {
  statusCode = 400;
  code = "LEAD_CREATE_REQUIREMENTS_UNMET";
  missingRequirements: {
    fields: Array<{ key: string; label: string }>;
  };

  constructor(fields: string[]) {
    super("Complete required lead creation fields before creating a lead.");
    this.name = "LeadCreateRequirementsError";
    this.missingRequirements = {
      fields: fields.map((key) => ({
        key,
        label: CREATE_GATE_FIELD_LABELS.get(key) ?? key,
      })),
    };
  }
}

export interface LeadBoardInput {
  role: string;
  userId: string;
  activeOfficeId: string;
  scope: WorkspaceScope;
  assignedRepId?: string;
  search?: string;
}

export interface LeadStagePageInput extends LeadBoardInput {
  stageId: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: string;
  assignedRepId?: string;
  staleOnly?: boolean;
  status?: string;
  workflowRoute?: string;
  source?: string;
}

type LeadStageRow = {
  id: string;
  name: string;
  stage_id: string;
  stage_slug: string | null;
  assigned_rep_id: string;
  office_id: string;
  company_name: string | null;
  property_city: string | null;
  property_state: string | null;
  source: string | null;
  status: string;
  last_activity_at: string | null;
  stage_entered_at: string;
  updated_at: string;
};

const NEW_LEAD_BOARD_STAGE_SLUGS = [
  "contacted",
  "lead_new",
  "company_pre_qualified",
  "scoping_in_progress",
  "new_lead",
] as const;

const QUALIFIED_LEAD_BOARD_STAGE_SLUGS = [
  "qualified_lead",
  "pre_qual_value_assigned",
  "director_go_no_go",
] as const;

function buildLeadEntityName(leadName: string, companyName?: string | null) {
  return companyName ? `${leadName} for ${companyName}` : leadName;
}

function toIsoIfDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function buildRawFieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[]
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = toIsoIfDate(before[key]);
    const to = toIsoIfDate(after[key]);
    if (from === to) continue;
    changes[key] = { from, to };
  }
  return changes;
}

const SALES_VALIDATION_BOARD_STAGE_SLUGS = [
  "lead_go_no_go",
  "qualified_for_opportunity",
  "ready_for_opportunity",
  "sales_validation_stage",
] as const;

const CANONICAL_LEAD_BOARD_STAGE_SLUGS = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
] as const;

type CanonicalLeadBoardStageSlug = (typeof CANONICAL_LEAD_BOARD_STAGE_SLUGS)[number];

async function resolveProjectType(
  projectTypeId: string | null | undefined,
  getProjectTypes: typeof getActiveProjectTypes
) {
  if (!projectTypeId) {
    return null;
  }

  const projectTypes = await getProjectTypes();
  const projectType = projectTypes.find((entry) => entry.id === projectTypeId) ?? null;

  if (!projectType) {
    throw new AppError(400, "Project type not found");
  }

  return projectType;
}

async function assertValidProjectType(
  value: string | null | undefined,
  getProjectTypes: typeof getActiveProjectTypes
): Promise<string> {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) {
    throw new AppError(400, `Invalid project type: ${value ?? ""}`.trim());
  }

  const projectTypes = await getProjectTypes();
  const match = projectTypes.find((projectType) => {
    const name = projectType.name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
    const slug = projectType.slug.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
    return name === normalized || slug === normalized;
  });

  if (!match) {
    throw new AppError(400, `Invalid project type: ${value ?? ""}`.trim());
  }

  return match.name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

function assertValidOfficeCode(value: string | null | undefined): "dfw" | "atl" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized !== "dfw" && normalized !== "atl") {
    throw new AppError(400, "officeCode must be 'dfw' or 'atl'", "INVALID_OFFICE_CODE");
  }

  return normalized;
}

function normalizeQualificationPayload(
  payload: Record<string, string | boolean | number | null> | undefined
) {
  return payload ?? {};
}

function normalizeProjectTypeQuestionPayload(
  projectTypeId: string | null,
  payload:
    | {
        projectTypeId: string | null;
        answers: Record<string, string | boolean | number | null>;
      }
    | undefined
) {
  return {
    projectTypeId,
    answers: payload?.answers ?? {},
  };
}

function coerceExistingQuestionPayload(value: unknown, projectTypeId: string | null) {
  const payload = value as { projectTypeId?: string | null; answers?: Record<string, string | boolean | number | null> } | null;

  return {
    projectTypeId: payload?.projectTypeId ?? projectTypeId,
    answers: payload?.answers ?? {},
  };
}

function normalizeStageSlugForTransitionValidation(stageSlug: string) {
  const canonicalStageSlug = toCanonicalLeadStageSlug(stageSlug);
  if (canonicalStageSlug === "sales_validation") {
    return "sales_validation_stage";
  }

  return canonicalStageSlug ?? stageSlug;
}

function assertCanonicalLeadProgression(
  currentStageSlug: string,
  targetStageSlug: string
) {
  const targetCanonicalStageSlug = toCanonicalLeadStageSlug(targetStageSlug);
  if (!targetCanonicalStageSlug) {
    return;
  }

  const currentCanonicalStageSlug = toCanonicalLeadStageSlug(currentStageSlug);
  if (!currentCanonicalStageSlug) {
    return;
  }

  const currentStageIndex = CANONICAL_LEAD_STAGE_INDEX.get(currentCanonicalStageSlug);
  const targetStageIndex = CANONICAL_LEAD_STAGE_INDEX.get(targetCanonicalStageSlug);
  if (currentStageIndex === undefined || targetStageIndex === undefined) {
    throw new AppError(
      409,
      "Lead stage is not part of the canonical workflow",
      "LEAD_STAGE_INVALID"
    );
  }

  if (targetStageIndex > currentStageIndex + 1) {
    throw new AppError(
      409,
      "Lead stage progression must move one canonical stage at a time",
      "LEAD_STAGE_PROGRESSION_GAP"
    );
  }
}

function assertLeadStartsInEntryStage(stageSlug: string) {
  const canonicalStageSlug = toCanonicalLeadStageSlug(stageSlug);
  if (canonicalStageSlug && canonicalStageSlug !== "new_lead") {
    throw new AppError(
      400,
      "New leads must start in the New Lead stage",
      "LEAD_CREATION_REQUIRES_ENTRY_STAGE"
    );
  }
}

async function decorateLeads(
  tenantDb: TenantDb,
  rows: Array<typeof leads.$inferSelect>,
  // Full stage-id -> name map over EVERY lead stage (canonical + alias), supplied by the caller (which
  // owns the getAllStages dependency). listLeads returns rows in their actual (possibly alias) stage, so
  // a canonical-only client map renders "—" for alias-stage leads; this resolves the real name (Codex
  // #577 P2). Optional — omitted callers leave stageName null.
  leadStageNameById?: Map<string, string | null>
) {
  if (rows.length === 0) {
    return [];
  }

  const companyIds = [...new Set(rows.map((lead) => lead.companyId).filter(Boolean))];
  const propertyIds = [...new Set(rows.map((lead) => lead.propertyId).filter(Boolean))];
  const projectTypeIds = [...new Set(rows.map((lead) => lead.projectTypeId).filter(Boolean))];
  const assignedRepIds = [...new Set(rows.map((lead) => lead.assignedRepId).filter(Boolean))];
  const primaryContactIds = [...new Set(rows.map((lead) => lead.primaryContactId).filter(Boolean))];
  const leadIds = rows.map((lead) => lead.id);

  // Sequential tenant queries required: tenantDb is a single transaction client
  // in production, so parallel reads can fail with "client already executing".
  const companyRows =
    companyIds.length === 0
      ? []
      : await tenantDb
          .select({
            id: companies.id,
            name: companies.name,
            ownerUserId: companies.ownerId,
            ownerUserName: users.displayName,
          })
          .from(companies)
          .leftJoin(users, eq(users.id, companies.ownerId))
          .where(inArray(companies.id, companyIds));
  const propertyRows =
    propertyIds.length === 0
      ? []
      : await tenantDb
          .select({
            id: properties.id,
            name: properties.name,
            address: properties.address,
            city: properties.city,
            state: properties.state,
            zip: properties.zip,
            buildYear: properties.buildYear,
            unitCount: properties.unitCount,
          })
          .from(properties)
          .where(inArray(properties.id, propertyIds));
  const projectTypeRows =
    projectTypeIds.length === 0
      ? []
      : await tenantDb
          .select({
            id: projectTypeConfig.id,
            name: projectTypeConfig.name,
            slug: projectTypeConfig.slug,
          })
          .from(projectTypeConfig)
          .where(inArray(projectTypeConfig.id, projectTypeIds as string[]));
  const assignedRepRows =
    assignedRepIds.length === 0
      ? []
      : await tenantDb
          .select({
            id: users.id,
            displayName: users.displayName,
          })
          .from(users)
          .where(inArray(users.id, assignedRepIds as string[]));
  const primaryContactRows =
    primaryContactIds.length === 0
      ? []
      : await tenantDb
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            jobTitle: contacts.jobTitle,
            ownerUserId: contacts.ownerId,
            ownerUserName: users.displayName,
          })
          .from(contacts)
          .leftJoin(users, eq(users.id, contacts.ownerId))
          .where(inArray(contacts.id, primaryContactIds as string[]));
  const convertedDealRows =
    leadIds.length === 0
      ? []
      : await tenantDb
          .select({
            sourceLeadId: deals.sourceLeadId,
            id: deals.id,
            dealNumber: deals.dealNumber,
          })
          .from(deals)
          .where(inArray(deals.sourceLeadId, leadIds));

  const companyMap = new Map(companyRows.map((company) => [company.id, company]));
  const propertyMap = new Map(propertyRows.map((property) => [property.id, property]));
  const projectTypeMap = new Map(projectTypeRows.map((projectType) => [projectType.id, projectType]));
  const assignedRepMap = new Map(assignedRepRows.map((rep) => [rep.id, rep.displayName]));
  const primaryContactMap = new Map(
    primaryContactRows.map((contact) => [
      contact.id,
      {
        name: [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || null,
        title: contact.jobTitle ?? null,
        ownerUserId: contact.ownerUserId ?? null,
        ownerUserName: contact.ownerUserName ?? null,
      },
    ])
  );
  const convertedDealMap = new Map(
    convertedDealRows
      .filter((deal) => deal.sourceLeadId)
      .map((deal) => [deal.sourceLeadId as string, { id: deal.id, dealNumber: deal.dealNumber }])
  );

  const v2Enabled = isLeadEditV2Enabled();
  const leadQuestionAnswerRows =
    v2Enabled && leadIds.length > 0
      ? await tenantDb.select().from(leadQuestionAnswers)
      : [];
  const questionNodes =
    v2Enabled && leadQuestionAnswerRows.length > 0
      ? await tenantDb.select().from(projectTypeConfig)
      : [];
  void questionNodes;
  const answerRowsByLeadId = new Map<string, Array<(typeof leadQuestionAnswers.$inferSelect)>>();

  for (const row of leadQuestionAnswerRows) {
    const rowsForLead = answerRowsByLeadId.get(row.leadId) ?? [];
    rowsForLead.push(row);
    answerRowsByLeadId.set(row.leadId, rowsForLead);
  }

  return rows.map((lead) => ({
    ...lead,
    stageName: leadStageNameById?.get(lead.stageId) ?? null,
    assignedRepName: assignedRepMap.get(lead.assignedRepId) ?? null,
    companyName: companyMap.get(lead.companyId)?.name ?? null,
    companyOwnerUserId: companyMap.get(lead.companyId)?.ownerUserId ?? null,
    companyOwnerUserName: companyMap.get(lead.companyId)?.ownerUserName ?? null,
    primaryContactName: lead.primaryContactId
      ? primaryContactMap.get(lead.primaryContactId)?.name ?? null
      : null,
    primaryContactTitle: lead.primaryContactId
      ? primaryContactMap.get(lead.primaryContactId)?.title ?? null
      : null,
    primaryContactOwnerUserId: lead.primaryContactId
      ? primaryContactMap.get(lead.primaryContactId)?.ownerUserId ?? null
      : null,
    primaryContactOwnerUserName: lead.primaryContactId
      ? primaryContactMap.get(lead.primaryContactId)?.ownerUserName ?? null
      : null,
    property: propertyMap.get(lead.propertyId) ?? null,
    projectType: lead.projectTypeId ? projectTypeMap.get(lead.projectTypeId) ?? null : null,
    convertedDealId: convertedDealMap.get(lead.id)?.id ?? null,
    convertedDealNumber: convertedDealMap.get(lead.id)?.dealNumber ?? null,
    leadQuestionAnswers: v2Enabled
      ? Object.fromEntries(
          (answerRowsByLeadId.get(lead.id) ?? []).map((row) => [row.questionId, row.valueJson ?? null])
        )
      : undefined,
  }));
}

function createLeadQuestionGateError(input: {
  currentStage: {
    id: string;
    slug: string;
    name: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  targetStage: {
    id: string;
    slug: string;
    name: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  qualificationFields: string[];
  projectTypeQuestionIds: string[];
}) {
  return new LeadStageTransitionError({
    allowed: false,
    code: "LEAD_STAGE_REQUIREMENTS_UNMET",
    message:
      "Complete the Sales Validation qualification fields and required project questions before moving this lead forward.",
    currentStage: input.currentStage,
    targetStage: input.targetStage,
    missingRequirements: {
      prerequisiteFields: [],
      qualificationFields: input.qualificationFields,
      projectTypeQuestionIds: input.projectTypeQuestionIds,
    },
  });
}

async function assertLeadQuestionGateAllowed(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    companyId: string;
    projectTypeId: string | null;
    qualificationPayload: Record<string, string | boolean | number | null>;
    leadQuestionAnswers: Record<string, LeadQuestionAnswerValue>;
    currentStage: {
      id: string;
      slug: string;
      name: string;
      isTerminal: boolean;
      displayOrder: number;
    };
    targetStage: {
      id: string;
      slug: string;
      name: string;
      isTerminal: boolean;
      displayOrder: number;
    };
  }
) {
  const existingCustomerStatus = await computeExistingCustomerStatus(tenantDb, input.companyId, new Date(), {
    excludeLeadId: input.leadId,
  });
  const { qualificationFields, projectTypeQuestionIds, missingScopeSelection } = await evaluateLeadQuestionGate(tenantDb, {
    leadId: input.leadId,
    projectTypeId: input.projectTypeId,
    qualificationPayload: input.qualificationPayload,
    leadQuestionAnswers: input.leadQuestionAnswers,
    existingCustomerStatus: existingCustomerStatus.status,
  });

  if (qualificationFields.length === 0 && projectTypeQuestionIds.length === 0 && !missingScopeSelection) {
    return;
  }

  throw createLeadQuestionGateError({
    currentStage: input.currentStage,
    targetStage: input.targetStage,
    qualificationFields,
    projectTypeQuestionIds: missingScopeSelection
      ? ["leadQuestionnaire.scopeRequired", ...projectTypeQuestionIds]
      : projectTypeQuestionIds,
  });
}

async function validateAssignee(tenantDb: TenantDb, assigneeId: string, officeId?: string): Promise<void> {
  const [user] = await tenantDb
    .select()
    .from(users)
    .where(and(eq(users.id, assigneeId), eq(users.isActive, true)))
    .limit(1);

  if (!user) {
    throw new AppError(400, "Assigned user not found, inactive, or unavailable for CRM ownership");
  }

  if (!officeId || user.officeId === officeId) {
    if (!isCrmUserRole(user.role)) {
      throw new AppError(400, "Assigned user not found, inactive, or unavailable for CRM ownership");
    }
    return;
  }

  const [access] = await tenantDb
    .select()
    .from(userOfficeAccess)
    .where(and(eq(userOfficeAccess.userId, assigneeId), eq(userOfficeAccess.officeId, officeId)))
    .limit(1);

  if (!access) {
    throw new AppError(400, "Assigned user does not have access to this office");
  }
  if (!isCrmUserRole(access.roleOverride ?? user.role)) {
    throw new AppError(400, "Assigned user not found, inactive, or unavailable for CRM ownership");
  }
}

async function validateOptionalUserId(
  tenantDb: TenantDb,
  userId: unknown,
  fieldName: string,
  officeId?: string
) {
  if (userId === undefined || userId === null) return;
  if (typeof userId !== "string" || !userId.trim()) {
    throw new AppError(400, `${fieldName} must be a valid user id or null`);
  }
  await validateAssignee(tenantDb, userId, officeId);
}

async function validateLeadHierarchy(
  tenantDb: TenantDb,
  input: Pick<CreateLeadInput, "companyId" | "propertyId" | "primaryContactId">
) {
  const [company] = await tenantDb
    .select()
    .from(companies)
    .where(and(eq(companies.id, input.companyId), eq(companies.isActive, true)))
    .limit(1);

  if (!company) {
    throw new AppError(400, "Company not found");
  }

  const [property] = await tenantDb
    .select()
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.isActive, true)))
    .limit(1);

  if (!property) {
    throw new AppError(400, "Property not found");
  }

  if (property.companyId !== input.companyId) {
    throw new AppError(400, "Property does not belong to the company");
  }

  await validatePrimaryContact(tenantDb, input.companyId, input.primaryContactId);
  return { company, property };
}

function isValidUsState(value: unknown) {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value.trim().toUpperCase());
}

function isValidZip(value: unknown) {
  return typeof value === "string" && /^\d{5}(-\d{4})?$/.test(value.trim());
}

function isBlank(value: unknown) {
  return typeof value !== "string" || value.trim().length === 0;
}

function isValidBuildYear(value: unknown, now: Date) {
  const maxYear = now.getFullYear() + 2;
  return Number.isInteger(value) && (value as number) >= 1800 && (value as number) <= maxYear;
}

function isPositiveInteger(value: unknown) {
  return Number.isInteger(value) && (value as number) > 0;
}

function normalizeIsoDateString(value: string) {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  const [year, month, day] = trimmed.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return trimmed;
}

function normalizeOptionalIsoDate(value: string | null | undefined, fieldName: string) {
  if (value == null || value.trim() === "") {
    return null;
  }

  const normalized = normalizeIsoDateString(value);
  if (!normalized) {
    throw new AppError(400, `${fieldName} must be an ISO date in YYYY-MM-DD format`);
  }
  return normalized;
}

async function resolveCreateStage(
  inputStageId: string | undefined,
  deps: LeadServiceDependencies
) {
  const stage = inputStageId
    ? await deps.getStageById(inputStageId, "lead")
    : await deps.getStageBySlug("new_lead", "lead");

  if (!stage) {
    throw new AppError(400, inputStageId ? "Invalid lead stage ID" : "Canonical 'new_lead' stage is not configured");
  }

  if (stage.isTerminal) {
    throw new AppError(400, "Cannot create a lead in a terminal stage");
  }

  if (!stage.slug) {
    throw new AppError(500, "Target lead stage config is incomplete");
  }

  assertLeadStartsInEntryStage(stage.slug);
  return stage;
}

function assertLeadCreateRequirements(
  input: CreateLeadInput,
  property: typeof properties.$inferSelect,
  now: Date
) {
  const missing: string[] = [];

  if (isBlank(property.address)) missing.push("property.address");
  if (isBlank(property.city)) missing.push("property.city");
  if (isBlank(property.state) || !isValidUsState(property.state)) missing.push("property.state");
  if (isBlank(property.zip) || !isValidZip(property.zip)) missing.push("property.zip");
  if (!isValidBuildYear(property.buildYear, now)) missing.push("property.buildYear");
  if (!isPositiveInteger(property.unitCount)) missing.push("property.unitCount");

  if (!input.primaryContactId?.trim()) missing.push("primaryContactId");
  if (!input.primaryContactRole || !LEAD_POC_ROLE_VALUES.has(input.primaryContactRole)) {
    missing.push("primaryContactRole");
  }
  if (input.primaryContactRole === "other" && !input.primaryContactRoleOtherLabel?.trim()) {
    missing.push("primaryContactRoleOtherLabel");
  }
  if (!input.budgetStatus || !LEAD_BUDGET_STATUS_VALUES.has(input.budgetStatus)) {
    missing.push("budgetStatus");
  }
  if (!input.projectTypeId?.trim()) {
    missing.push("projectTypeId");
  }
  if (!input.bidDueDate || !normalizeIsoDateString(input.bidDueDate)) {
    missing.push("bidDueDate");
  }

  if (missing.length > 0) {
    throw new LeadCreateRequirementsError([...new Set(missing)]);
  }
}

async function validatePrimaryContact(
  tenantDb: TenantDb,
  companyId: string,
  primaryContactId?: string | null
) {
  if (!primaryContactId) {
    return;
  }

  const [contact] = await tenantDb
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, primaryContactId), eq(contacts.isActive, true)))
    .limit(1);

  if (!contact) {
    throw new AppError(400, "Primary contact not found");
  }

  if (contact.companyId !== companyId) {
    throw new AppError(400, "Primary contact does not belong to the company");
  }
}

async function listLeadStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .where(
      and(
        eq(pipelineStageConfig.workflowFamily, "lead"),
        eq(pipelineStageConfig.isActivePipeline, true),
        inArray(pipelineStageConfig.slug, [...CANONICAL_LEAD_BOARD_STAGE_SLUGS])
      )
    )
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

async function getDefaultConversionDealStageId() {
  const [stage] = await db
    .select({ id: pipelineStageConfig.id })
    .from(pipelineStageConfig)
    .where(
      and(
        eq(pipelineStageConfig.workflowFamily, "standard_deal"),
        eq(pipelineStageConfig.isActivePipeline, true)
      )
    )
    .orderBy(asc(pipelineStageConfig.displayOrder))
    .limit(1);

  return stage?.id ?? null;
}

// The unaliased lead search builder (used by listLeads below) now lives in the shared
// unified-search module, so the lead field set is a single source of truth (mirrors deals).
// Re-exported here for existing importers; escapeLikePattern is imported from there as well.
export { buildLeadSearchCondition };

export function buildAliasedLeadSearchCondition(
  leadAlias: string,
  search: string,
  companyAlias = "c",
  propertyAlias = "p"
) {
  const searchTerm = `%${escapeLikePattern(search.trim())}%`;
  const leadColumn = (column: string) => sql.raw(`${leadAlias}.${column}`);
  const companyColumn = (column: string) => sql.raw(`${companyAlias}.${column}`);
  const propertyColumn = (column: string) => sql.raw(`${propertyAlias}.${column}`);

  return sql`(
    ${leadColumn("name")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${leadColumn("source")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${leadColumn("source_detail")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${leadColumn("description")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${companyColumn("name")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${propertyColumn("name")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${propertyColumn("address")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${propertyColumn("city")} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${propertyColumn("state")} ILIKE ${searchTerm} ESCAPE '\\'
    OR EXISTS (
      SELECT 1
      FROM ${contacts}
      WHERE ${contacts.id} = ${leadColumn("primary_contact_id")}
        AND (
          ${contacts.firstName} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${contacts.lastName} ILIKE ${searchTerm} ESCAPE '\\'
          OR CONCAT(${contacts.firstName}, ' ', ${contacts.lastName}) ILIKE ${searchTerm} ESCAPE '\\'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.users owner_user
      WHERE owner_user.id = ${leadColumn("assigned_rep_id")}
        AND owner_user.display_name ILIKE ${searchTerm} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM ${deals}
      WHERE ${deals.sourceLeadId} = ${leadColumn("id")}
        AND (
          ${deals.dealNumber} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${deals.projectNumber} ILIKE ${searchTerm} ESCAPE '\\'
        )
    )
  )`;
}

async function buildLeadWorkspaceScope(tenantDb: TenantDb, input: LeadBoardInput | LeadStagePageInput) {
  const activeOfficeScope = await resolveActiveOfficeScope(tenantDb, input.activeOfficeId);
  const filters = [
    sql`l.is_active = true`,
    buildLeadOfficeScopeCondition("l", activeOfficeScope),
  ];
  const mineVisibility = input.scope === "mine" ? await resolveMineVisibilityFeatures(tenantDb) : null;

  if (input.scope === "mine") {
    filters.push(
      buildAliasedLeadMineVisibilityCondition("l", input.userId, {
        includeSubscriptions: mineVisibility?.leadSubscriptions,
        includeCreatedBy: mineVisibility?.leadsCreatedByUserId,
        includeSubscriptionDeletedAt: mineVisibility?.leadSubscriptionsDeletedAt,
      })
    );
  } else if (input.scope === "team") {
    const teamRepIds = await resolveTeamRepIds(tenantDb, input.userId, input.activeOfficeId);
    filters.push(teamRepIds.length > 0 ? sql`l.assigned_rep_id IN (${sql.join(teamRepIds.map((id) => sql`${id}`), sql`, `)})` : sql`false`);
  }

  if ("assignedRepId" in input && input.assignedRepId) {
    filters.push(sql`l.assigned_rep_id = ${input.assignedRepId}`);
  }

  if ("status" in input && input.status) {
    filters.push(sql`l.status = ${input.status}`);
  } else {
    filters.push(sql`l.status = 'open'`);
  }

  if ("source" in input && input.source) {
    filters.push(sql`l.source = ${input.source}`);
  }

  if ("search" in input && input.search && input.search.trim().length >= 2) {
    filters.push(buildAliasedLeadSearchCondition("l", input.search));
  }

  if ("staleOnly" in input && input.staleOnly) {
    filters.push(sql`l.last_activity_at is null or l.last_activity_at < now() - interval '14 days'`);
  }

  return sql.join(filters, sql` and `);
}

function normalizeLeadStageSort(sort?: string) {
  switch (sort) {
    case "name_asc":
      return sql`l.name asc, l.updated_at desc`;
    case "age_desc":
      return sql`l.stage_entered_at asc, l.updated_at desc`;
    default:
      return sql`l.updated_at desc, l.name asc`;
  }
}

function mapLeadStageRow(row: LeadStageRow) {
  return {
    id: row.id,
    name: row.name,
    stageId: row.stage_id,
    assignedRepId: row.assigned_rep_id,
    officeId: row.office_id,
    companyName: row.company_name,
    propertyCity: row.property_city,
    propertyState: row.property_state,
    source: row.source,
    status: row.status,
    lastActivityAt: row.last_activity_at,
    stageEnteredAt: row.stage_entered_at,
    updatedAt: row.updated_at,
  };
}

function resolveCanonicalLeadBoardStageSlug(
  stageSlug: string | null | undefined
): CanonicalLeadBoardStageSlug | null {
  if (!stageSlug) {
    return null;
  }

  if (NEW_LEAD_BOARD_STAGE_SLUGS.includes(stageSlug as (typeof NEW_LEAD_BOARD_STAGE_SLUGS)[number])) {
    return "new_lead";
  }

  if (QUALIFIED_LEAD_BOARD_STAGE_SLUGS.includes(stageSlug as (typeof QUALIFIED_LEAD_BOARD_STAGE_SLUGS)[number])) {
    return "qualified_lead";
  }

  if (
    SALES_VALIDATION_BOARD_STAGE_SLUGS.includes(
      stageSlug as (typeof SALES_VALIDATION_BOARD_STAGE_SLUGS)[number]
    )
  ) {
    return "sales_validation_stage";
  }

  return null;
}

function listCanonicalBucketStageSlugs(canonicalStageSlug: string): readonly string[] {
  switch (canonicalStageSlug) {
    case "new_lead":
      return NEW_LEAD_BOARD_STAGE_SLUGS;
    case "qualified_lead":
      return QUALIFIED_LEAD_BOARD_STAGE_SLUGS;
    case "sales_validation_stage":
      return SALES_VALIDATION_BOARD_STAGE_SLUGS;
    default:
      return [canonicalStageSlug];
  }
}

/**
 * Expand the leads FilterBar's stage selection into the concrete stage ids to
 * filter `leads.stage_id` against. The bar emits CANONICAL board-stage ids
 * (`column.stage.id`); each is resolved to its slug, mapped to its canonical
 * board bucket, and expanded to that bucket's full alias family — the SAME
 * grouping the kanban board uses (listCanonicalBucketStageSlugs), so the list and
 * the board agree on what "New Lead" means. A valid stage id that is NOT part of a
 * canonical family (e.g. an inactive or custom stage) matches itself only, keeping
 * the legacy exact-id behavior. Malformed (non-uuid) values are dropped — never
 * widened, never passed into a uuid-cast that would throw. Pure (no DB) so it is
 * unit-testable; the caller supplies the lead-family stages.
 */
export function resolveLeadStageBucketIds(
  incomingStageIds: string[],
  leadStages: Array<{ id: string; slug: string }>
): string[] {
  const idToSlug = new Map(leadStages.map((stage) => [stage.id, stage.slug]));
  const slugToIds = new Map<string, string[]>();
  for (const stage of leadStages) {
    const ids = slugToIds.get(stage.slug) ?? [];
    ids.push(stage.id);
    slugToIds.set(stage.slug, ids);
  }

  const resolved = new Set<string>();
  for (const value of incomingStageIds) {
    const slug = idToSlug.get(value);
    if (slug) {
      const canonical = resolveCanonicalLeadBoardStageSlug(slug);
      const familySlugs = canonical ? listCanonicalBucketStageSlugs(canonical) : [slug];
      for (const familySlug of familySlugs) {
        for (const id of slugToIds.get(familySlug) ?? []) {
          resolved.add(id);
        }
      }
    } else if (LEAD_FILTER_UUID_RE.test(value)) {
      // Valid uuid but not a known lead stage (inactive/foreign) — exact match only.
      resolved.add(value);
    }
    // Anything else (malformed) is dropped: no-match, never widen.
  }
  return [...resolved];
}

function groupLeadBoardColumns(
  stages: Awaited<ReturnType<typeof listLeadStages>>,
  rows: LeadStageRow[]
) {
  return stages.map((stage) => {
    const cards = rows
      .filter((row) => resolveCanonicalLeadBoardStageSlug(row.stage_slug) === stage.slug)
      .map(mapLeadStageRow);

    return {
      stage,
      count: cards.length,
      cards,
    };
  });
}

async function listLeadBoardWorkspace(tenantDb: TenantDb, input: LeadBoardInput) {
  const [stages, defaultConversionDealStageId, rowResult] = await Promise.all([
    listLeadStages(),
    getDefaultConversionDealStageId(),
    tenantDb.execute(sql`
      select
        l.id,
        l.name,
        l.stage_id,
        psc.slug as stage_slug,
        l.assigned_rep_id,
        u.office_id,
        c.name as company_name,
        p.city as property_city,
        p.state as property_state,
        l.source,
        l.status,
        l.last_activity_at,
        l.stage_entered_at,
        l.updated_at
      from leads l
      left join users u on u.id = l.assigned_rep_id
      join public.pipeline_stage_config psc on psc.id = l.stage_id
      left join companies c on c.id = l.company_id
      left join properties p on p.id = l.property_id
      where ${await buildLeadWorkspaceScope(tenantDb, input)}
      order by l.stage_entered_at asc, l.updated_at desc
    `),
  ]);

  return {
    columns: groupLeadBoardColumns(stages, rowResult.rows as LeadStageRow[]),
    defaultConversionDealStageId,
  };
}

async function listLeadStageWorkspacePage(tenantDb: TenantDb, input: LeadStagePageInput) {
  const [stage] = await listLeadStages().then((stages) => stages.filter((item) => item.id === input.stageId));
  if (!stage) {
    throw new AppError(404, "Lead stage not found");
  }
  const bucketStageSlugs = listCanonicalBucketStageSlugs(stage.slug);

  const page = Math.max(1, input.page || 1);
  const pageSize = Math.max(1, Math.min(100, input.pageSize || 25));
  const offset = (page - 1) * pageSize;
  const scope = await buildLeadWorkspaceScope(tenantDb, input);
  const countResult = await tenantDb.execute(sql`
    select count(*)::int as total
    from leads l
    left join users u on u.id = l.assigned_rep_id
    join public.pipeline_stage_config psc on psc.id = l.stage_id
    left join companies c on c.id = l.company_id
    left join properties p on p.id = l.property_id
    where ${scope} and psc.slug in ${bucketStageSlugs}
  `);
  const rowResult = await tenantDb.execute(sql`
    select
      l.id,
      l.name,
      l.stage_id,
      psc.slug as stage_slug,
      l.assigned_rep_id,
      u.office_id,
      c.name as company_name,
      p.city as property_city,
      p.state as property_state,
      l.source,
      l.status,
      l.last_activity_at,
      l.stage_entered_at,
      l.updated_at
    from leads l
    left join users u on u.id = l.assigned_rep_id
    join public.pipeline_stage_config psc on psc.id = l.stage_id
    left join companies c on c.id = l.company_id
    left join properties p on p.id = l.property_id
    where ${scope} and psc.slug in ${bucketStageSlugs}
    order by ${normalizeLeadStageSort(input.sort)}
    limit ${pageSize}
    offset ${offset}
  `);

  const total = Number((countResult.rows[0] as { total?: number | string } | undefined)?.total ?? 0);

  return {
    stage,
    scope: input.scope,
    summary: {
      count: total,
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / pageSize),
    },
    rows: (rowResult.rows as LeadStageRow[]).map(mapLeadStageRow),
  };
}

export function createLeadService(
  dependencies: Partial<LeadServiceDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };

  async function getLeadById(
    tenantDb: TenantDb,
    leadId: string,
    userRole: string,
    userId: string
  ) {
    const [lead] = await tenantDb.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return null;

    if (userRole === "rep" && lead.assignedRepId !== userId) {
      throw new AppError(403, "You can only view your own leads");
    }

    // getLeadById omits the stage-name map (the detail view renders stage separately); only the flat
    // list needs alias-stage names, so this single-lead path stays unchanged (Codex #577 P2).
    const decoratedLead = (await decorateLeads(tenantDb, [lead]))[0] ?? null;
    if (!decoratedLead) {
      return null;
    }

    const existingCustomerStatus = await computeExistingCustomerStatus(tenantDb, lead.companyId, new Date(), {
      excludeLeadId: lead.id,
    });
    return {
      ...decoratedLead,
      existingCustomerStatus: existingCustomerStatus.status,
    };
  }

  async function listLeads(
    tenantDb: TenantDb,
    filters: LeadFilters,
    userRole: string,
    userId: string
  ) {
    const conditions: any[] = [];
    const scope = filters.scope ?? "mine";

    if (filters.isActive !== "all") {
      conditions.push(eq(leads.isActive, filters.isActive ?? true));
    } else {
      // isActive="all" surfaces active rows AND legitimately-inactive ones (converted leads
      // are isActive=false+status=converted; disqualified leads are isActive=false+
      // status=disqualified) — but must STILL hide SOFT-DELETED leads. deleteLead only runs
      // on an ACTIVE lead (returns early when !isActive), and active leads are always
      // status=open (converting and disqualifying both set isActive=false), so a soft-deleted
      // lead is uniquely isActive=false AND status=open. Exclude exactly that combo; keep
      // every other state (active-open, converted, disqualified).
      conditions.push(
        sql`NOT (${leads.isActive} = false AND ${leads.status}::text = 'open')`
      );
    }

    if (filters.activeOfficeId) {
      const officeScope = await resolveActiveOfficeScope(tenantDb, filters.activeOfficeId);
      conditions.push(buildLeadOfficeScopeCondition("leads", officeScope));
    }

    const mineVisibility = scope === "mine" ? await resolveMineVisibilityFeatures(tenantDb) : null;

    if (scope === "mine") {
      conditions.push(
        buildLeadMineVisibilityCondition(userId, {
          includeSubscriptions: mineVisibility?.leadSubscriptions,
          includeCreatedBy: mineVisibility?.leadsCreatedByUserId,
          includeSubscriptionDeletedAt: mineVisibility?.leadSubscriptionsDeletedAt,
        })
      );
    } else if (scope === "team") {
      const teamUserIds = await resolveTeamRepIds(tenantDb, userId, filters.activeOfficeId ?? null);
      conditions.push(teamUserIds.length > 0 ? inArray(leads.assignedRepId, teamUserIds) : sql`false`);
    }

    if (filters.assignedRepId) {
      conditions.push(eq(leads.assignedRepId, filters.assignedRepId));
    }

    if (filters.stageIds && filters.stageIds.length > 0) {
      // The bar sends canonical board-stage ids; expand each to its alias family.
      const leadStages = await deps.getAllStages("lead");
      const stageIds = resolveLeadStageBucketIds(filters.stageIds, leadStages);
      // All values resolved to nothing (malformed/unknown) -> no-match, never widen.
      conditions.push(stageIds.length > 0 ? inArray(leads.stageId, stageIds) : sql`false`);
    }

    if (filters.projectTypeId) {
      // Malformed id no-matches (and never reaches a uuid cast that would throw).
      conditions.push(
        LEAD_FILTER_UUID_RE.test(filters.projectTypeId)
          ? eq(leads.projectTypeId, filters.projectTypeId)
          : sql`false`
      );
    }

    if (filters.companyId) conditions.push(eq(leads.companyId, filters.companyId));
    if (filters.propertyId) conditions.push(eq(leads.propertyId, filters.propertyId));
    if (filters.status) conditions.push(eq(leads.status, filters.status));
    if (filters.createdFrom) {
      conditions.push(sql`${leads.createdAt} >= ${filters.createdFrom}::date`);
    }
    if (filters.createdTo) {
      conditions.push(sql`${leads.createdAt} < (${filters.createdTo}::date + interval '1 day')`);
    }

    // Outcome-aware date window (FilterBar Wave 1). Distinct from createdFrom/createdTo:
    // windows converted rows on converted_at, disqualified on disqualified_at, open on
    // stage-entry (fallback created_at) — the shared lead-date-scope predicate.
    const leadDateScope = buildLeadOutcomeDateScope(
      { from: filters.dateFrom, to: filters.dateTo },
      {}
    );
    if (leadDateScope) {
      conditions.push(leadDateScope);
    }

    if (filters.search && filters.search.trim().length >= 2) {
      conditions.push(buildLeadSearchCondition(filters.search));
    }

    const sortColumn = filters.sortBy === "created_at" ? leads.createdAt : leads.updatedAt;
    const sortOrder = filters.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

    const query = tenantDb
      .select({
        ...getTableColumns(leads),
        // filter-axis == display-axis: the date the row DISPLAYS is the same outcome-aware
        // axis buildLeadOutcomeDateScope filters on. ISO YYYY-MM-DD (or null). RED reads it
        // as `displayDate`, falling back to the lead date chain until selected.
        displayDate: sql<string | null>`to_char(${leadDisplayDateExpr({})}, 'YYYY-MM-DD')`,
      })
      .from(leads)
      .where(and(...conditions))
      .orderBy(sortOrder, asc(leads.name));
    // The row cap is OPT-IN: only the FilterBar list passes `limit`, so it alone is bounded. Aggregate
    // consumers that omit it (dashboard metrics, director rep totals, company portfolio) MUST receive the
    // FULL set — a default cap would silently compute counts/forecasts from the first N rows (Codex #577
    // P1). When a limit IS requested, clamp it to [1, LEADS_LIST_MAX_ROWS].
    const rows =
      filters.limit != null
        ? await query.limit(Math.min(Math.max(filters.limit, 1), LEADS_LIST_MAX_ROWS))
        : await query;

    const leadStageNameById = new Map(
      (await deps.getAllStages("lead")).map((stage) => [stage.id, stage.name ?? null] as [string, string | null])
    );
    return decorateLeads(tenantDb, rows, leadStageNameById);
  }

  async function createLead(tenantDb: TenantDb, input: CreateLeadInput) {
    const stage = await resolveCreateStage(input.stageId, deps);
    const now = deps.now();
    const hierarchy = await validateLeadHierarchy(tenantDb, input);
    await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
    await validateOptionalUserId(tenantDb, input.salesRepId, "salesRepId", input.officeId);
    const resolvedProjectType = await resolveProjectType(input.projectTypeId ?? null, deps.getActiveProjectTypes);
    const officeCode = assertValidOfficeCode(input.officeCode);
    assertLeadCreateRequirements(input, hierarchy.property, now);
    if (!resolvedProjectType) {
      throw new AppError(400, "Project type is required");
    }
    // leads.project_type stores the legacy normalized display value; project_type_id
    // is the canonical config FK used by the new create gate.
    const projectType = resolvedProjectType.name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

    const v2Enabled = isLeadEditV2Enabled();
    const sourceWrite = resolveLeadSourceForWrite({
      source: input.source,
      sourceCategory: input.sourceCategory,
      sourceDetail: input.sourceDetail,
    });
    const normalizedQualificationPayload = normalizeQualificationPayload(input.qualificationPayload);
    const normalizedProjectTypeQuestionPayload = normalizeProjectTypeQuestionPayload(
      input.projectTypeId ?? null,
      input.projectTypeQuestionPayload
    );
    const leadQuestionAnswerInput =
      input.leadQuestionAnswers ??
      normalizedProjectTypeQuestionPayload.answers ??
      {};
    const normalizedBidDueDate = normalizeOptionalIsoDate(input.bidDueDate, "bidDueDate");

    let resolvedStageId = stage.id;
    let verificationStatus: "not_required" | "pending" = "not_required";
    let verificationRequiredReason: string | null = null;
    const existingCustomerDecision = await isExistingCustomer(
      tenantDb,
      input.companyId,
      input.primaryContactId ?? null,
      input.propertyId,
      now
    );

    if (existingCustomerDecision.isExisting) {
      const qualifiedStage = await deps.getStageBySlug("qualified_lead", "lead");
      if (!qualifiedStage) {
        throw new AppError(500, "Canonical 'qualified_lead' stage is not configured");
      }
      resolvedStageId = qualifiedStage.id;
    } else {
      verificationStatus = "pending";
      verificationRequiredReason = "new_company";
    }

    const [lead] = await tenantDb
      .insert(leads)
      .values({
        companyId: input.companyId,
        propertyId: input.propertyId,
        primaryContactId: input.primaryContactId ?? null,
        primaryContactRole: input.primaryContactRole ?? null,
        primaryContactRoleOtherLabel:
          input.primaryContactRole === "other" ? input.primaryContactRoleOtherLabel?.trim() ?? null : null,
        name: input.name,
        stageId: resolvedStageId,
        assignedRepId: input.assignedRepId,
        salesRepId: input.salesRepId ?? null,
        status: "open",
        source: v2Enabled ? null : input.source ?? null,
        sourceCategory: sourceWrite.sourceCategory,
        sourceDetail: sourceWrite.sourceDetail,
        description: input.description ?? null,
        officeCode,
        office: officeCode,
        projectType,
        projectTypeId: input.projectTypeId ?? null,
        bidDueDate: normalizedBidDueDate,
        budgetStatus: input.budgetStatus ?? null,
        qualificationPayload: normalizedQualificationPayload,
        projectTypeQuestionPayload: v2Enabled
          ? { projectTypeId: input.projectTypeId ?? null, answers: {} }
          : normalizedProjectTypeQuestionPayload,
        createdByUserId: input.actorUserId ?? null,
        verificationStatus,
        verificationRequiredReason,
        stageEnteredAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (v2Enabled) {
      const activeNodes = await listQuestionnaireNodes(tenantDb);
      const bidDueDateNodeAvailable = activeNodes.some((node) => node.key === "bid_due_date");
      // V2 mirror: lead_question_answers is kept in sync for edit-mode questionnaire UI.
      // Source of truth is leads.bid_due_date. The mirror is best-effort and
      // skipped when bid_due_date is not an active questionnaire node because
      // upsertLeadQuestionAnswerSet rejects unknown keys.
      const v2MirrorAnswers = {
        ...leadQuestionAnswerInput,
        ...(bidDueDateNodeAvailable ? { bid_due_date: normalizedBidDueDate } : {}),
      };
      if (Object.keys(v2MirrorAnswers).length > 0) {
        await upsertLeadQuestionAnswerSet(tenantDb, {
          leadId: lead.id,
          projectTypeId: input.projectTypeId ?? null,
          changedBy: input.assignedRepId,
          answers: v2MirrorAnswers,
          changedAt: now,
        });
      }
    }

    // verification_status is a compat mirror; lead_due_diligence_approvals is
    // the source of truth for the qualified_lead stage gate.
    if (verificationStatus === "pending") {
      await createLeadDueDiligenceApproval(tenantDb, {
        leadId: lead.id,
        requestedBy: input.assignedRepId,
        detectionSignal: existingCustomerDecision.signal,
        now,
      });
    }

    if (input.actorUserId) {
      await createAssignmentTaskIfNeeded(tenantDb, {
        entityType: "lead",
        entityId: lead.id,
        entityName: lead.name,
        previousAssignedRepId: null,
        nextAssignedRepId: lead.assignedRepId,
        actorUserId: input.actorUserId,
        officeId: input.officeId ?? null,
      });
    }

    if (input.auditContext) {
      await logActivity({
        tenantDb,
        actor: input.auditContext.actor,
        action: "insert",
        entity: {
          tableName: "leads",
          entityType: "lead",
          recordId: lead.id,
          nameSnapshot: buildLeadEntityName(lead.name, hierarchy.company.name),
          secondaryIdSnapshot: null,
        },
        fieldChanges: {
          name: { from: null, to: lead.name },
          stageId: { from: null, to: resolvedStageId },
          assignedRepId: { from: null, to: lead.assignedRepId },
          status: { from: null, to: lead.status },
        },
        ipAddress: input.auditContext.ipAddress ?? null,
        userAgent: input.auditContext.userAgent ?? null,
      });
    }

    return lead;
  }

  async function updateLead(
    tenantDb: TenantDb,
    leadId: string,
    input: UpdateLeadInput,
    userRole: string,
    userId: string
  ) {
    if (input.assignedRepId !== undefined) {
      input = { ...input, assignedRepId: requireUuid(input.assignedRepId, "assignedRepId") };
    }
    // Ownership transfers are security-sensitive and can be initiated by the current owner. Lock before
    // reading the owner so two concurrent transfers cannot both authorize against the same stale owner.
    if (input.assignedRepId !== undefined) {
      const lockQuery = tenantDb
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1) as any;
      if (typeof lockQuery.for === "function") {
        await lockQuery.for("update");
      } else {
        await lockQuery;
      }
    }

    const existing = await getLeadById(tenantDb, leadId, userRole, userId);
    if (!existing) {
      throw new AppError(404, "Lead not found");
    }

    const canEditAnyLead = userRole === "admin" || userRole === "director";
    if (!canEditAnyLead && existing.assignedRepId !== userId) {
      throw new AppError(403, "You can only edit your own leads");
    }

    const v2Enabled = isLeadEditV2Enabled();
    const isConvertedLead = existing.status === "converted";

    if (!existing.isActive && !isConvertedLead) {
      throw new AppError(409, "Hidden lead records are read-only");
    }

    const normalizedOfficeCode = input.officeCode !== undefined
      ? assertValidOfficeCode(input.officeCode)
      : undefined;
    const normalizedOffice = input.office !== undefined
      ? assertValidOfficeCode(input.office)
      : undefined;

    if (
      normalizedOfficeCode !== undefined &&
      existing.officeCode != null &&
      normalizedOfficeCode !== existing.officeCode
    ) {
      throw new AppError(422, "office_code cannot be changed once set", "LEAD_OFFICE_IMMUTABLE");
    }

    if (
      normalizedOffice !== undefined &&
      existing.office != null &&
      normalizedOffice !== existing.office
    ) {
      throw new AppError(422, "office cannot be changed once set", "LEAD_OFFICE_IMMUTABLE");
    }

    if (isConvertedLead) {
      const nonAnswerKeys = Object.keys(input).filter(
        (key) => key !== "leadQuestionAnswers" && key !== "officeId"
      );

      if (nonAnswerKeys.length > 0) {
        throw new AppError(409, "Converted leads only allow questionnaire answer updates");
      }

      if (v2Enabled && input.leadQuestionAnswers) {
        await upsertLeadQuestionAnswerSet(tenantDb, {
          leadId,
          projectTypeId: existing.projectTypeId ?? null,
          changedBy: userId,
          answers: input.leadQuestionAnswers,
          changedAt: deps.now(),
        });
      }

      return existing;
    }

    const updates: Record<string, unknown> = {};
    const effectiveProjectTypeId =
      input.projectTypeId !== undefined ? input.projectTypeId : existing.projectTypeId;
    const nextAssignedRepId =
      input.assignedRepId !== undefined ? input.assignedRepId : existing.assignedRepId;
    let assignedRepChanged = false;
    let stageChangeAuditRecord:
      | {
          leadId: string;
          fromStageId: string | null;
          toStageId: string;
          changedBy: string;
          isBackwardMove: boolean;
          durationInPreviousStage: null;
          createdAt: Date;
        }
      | null = null;
    let stageChangeActivityCopy:
      | {
          fromStageName: string;
          toStageName: string;
        }
      | null = null;
    let stageChangedAt: Date | null = null;
    const effectiveQualificationPayload =
      input.qualificationPayload !== undefined
        ? normalizeQualificationPayload(input.qualificationPayload)
        : normalizeQualificationPayload(
            existing.qualificationPayload as Record<string, string | boolean | number | null>
          );
    const effectiveLeadQuestionAnswers = input.leadQuestionAnswers ?? {};

    if (input.stageId !== undefined) {
      const stage = await deps.getStageById(input.stageId, "lead");
      if (!stage) {
        throw new AppError(400, "Invalid lead stage ID");
      }

      const currentStage = await deps.getStageById(existing.stageId, "lead");
      if (!currentStage?.slug || currentStage.displayOrder == null || !currentStage.name) {
        throw new AppError(500, "Current lead stage config is incomplete");
      }
      if (!stage.slug || stage.displayOrder == null || !stage.name) {
        throw new AppError(500, "Target lead stage config is incomplete");
      }

      assertCanonicalLeadProgression(currentStage.slug, stage.slug);

      const currentStageInput = {
        id: currentStage.id,
        slug: normalizeStageSlugForTransitionValidation(currentStage.slug),
        name: currentStage.name,
        isTerminal: currentStage.isTerminal,
        displayOrder: currentStage.displayOrder,
      };
      const targetStageInput = {
        id: stage.id,
        slug: normalizeStageSlugForTransitionValidation(stage.slug),
        name: stage.name,
        isTerminal: stage.isTerminal,
        displayOrder: stage.displayOrder,
      };

      if (v2Enabled) {
        const enteringSalesValidation =
          stage.slug === "sales_validation_stage" && currentStage.slug !== "sales_validation_stage";

        if (enteringSalesValidation) {
          await assertLeadQuestionGateAllowed(tenantDb, {
            leadId: existing.id,
            companyId: existing.companyId,
            projectTypeId: effectiveProjectTypeId ?? null,
            qualificationPayload: effectiveQualificationPayload,
            leadQuestionAnswers: effectiveLeadQuestionAnswers,
            currentStage: currentStageInput,
            targetStage: targetStageInput,
          });
        }
      } else {
        const projectType = await resolveProjectType(effectiveProjectTypeId ?? null, deps.getActiveProjectTypes);
        assertLeadStageTransitionAllowed({
          lead: {
            id: existing.id,
            stageId: existing.stageId,
            stageSlug: currentStage.slug,
            source: input.source !== undefined ? input.source : existing.source,
            projectTypeId: effectiveProjectTypeId ?? null,
            qualificationPayload: effectiveQualificationPayload,
            projectTypeQuestionPayload:
              input.projectTypeQuestionPayload !== undefined || input.projectTypeId !== undefined
                ? normalizeProjectTypeQuestionPayload(
                    effectiveProjectTypeId ?? null,
                    input.projectTypeQuestionPayload
                  )
                : coerceExistingQuestionPayload(
                  existing.projectTypeQuestionPayload,
                  effectiveProjectTypeId ?? null
                ),
          },
          currentStage: currentStageInput,
          targetStage: targetStageInput,
          projectTypeSlug: projectType?.slug ?? null,
        });
      }

      updates.stageId = input.stageId;
      stageChangedAt = deps.now();
      updates.stageEnteredAt = stageChangedAt;

      if (input.stageId !== existing.stageId) {
        stageChangeAuditRecord = {
          leadId: existing.id,
          fromStageId: existing.stageId,
          toStageId: input.stageId,
          changedBy: userId,
          isBackwardMove: stage.displayOrder < currentStage.displayOrder,
          durationInPreviousStage: null,
          createdAt: stageChangedAt,
        };
        stageChangeActivityCopy = {
          fromStageName: currentStage.name,
          toStageName: stage.name,
        };
      }
    }

    if (input.assignedRepId !== undefined) {
      await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
      updates.assignedRepId = input.assignedRepId;
      assignedRepChanged = input.assignedRepId !== existing.assignedRepId;
      if (assignedRepChanged) {
        // A real owner transfer must also move the legacy conversion fallback. Keep this invariant in the
        // service for direct callers such as the ownership cleanup queue. A no-op owner patch deliberately
        // leaves a separately designated sales rep untouched.
        updates.salesRepId = input.assignedRepId;
        // The import/sync job deliberately preserves manual_override rows. Without this marker, the next
        // HubSpot ownership pass can silently undo a reassignment made in CRM.
        updates.ownershipSyncStatus = "manual_override";
        updates.unassignedReasonCode = null;
      }
    }

    if (input.salesRepId !== undefined && input.assignedRepId === undefined) {
      await validateOptionalUserId(tenantDb, input.salesRepId, "salesRepId", input.officeId);
      updates.salesRepId = input.salesRepId;
    }

    if (input.primaryContactId !== undefined) {
      if (input.primaryContactId !== existing.primaryContactId) {
        await validatePrimaryContact(tenantDb, existing.companyId, input.primaryContactId);
      }
      updates.primaryContactId = input.primaryContactId;
    }

    if (input.projectTypeId !== undefined) {
      await resolveProjectType(input.projectTypeId, deps.getActiveProjectTypes);
      updates.projectTypeId = input.projectTypeId;
    }

    if (input.projectType !== undefined) {
      updates.projectType =
        input.projectType === null ? null : await assertValidProjectType(input.projectType, deps.getActiveProjectTypes);
    }

    if (input.officeCode !== undefined) {
      updates.officeCode = normalizedOfficeCode;
    }

    if (input.name !== undefined) updates.name = input.name;
    if (input.sourceCategory !== undefined || input.sourceDetail !== undefined) {
      const sourceWrite = resolveLeadSourceForWrite({
        sourceCategory: input.sourceCategory,
        sourceDetail: input.sourceDetail,
      });
      updates.sourceCategory = sourceWrite.sourceCategory;
      updates.sourceDetail = sourceWrite.sourceDetail;
    } else if (!v2Enabled && input.source !== undefined) {
      updates.source = input.source;
    }
    if (input.description !== undefined) updates.description = input.description;
    if (input.qualificationPayload !== undefined) {
      updates.qualificationPayload = normalizeQualificationPayload(input.qualificationPayload);
    }
    if (!v2Enabled && (input.projectTypeQuestionPayload !== undefined || input.projectTypeId !== undefined)) {
      updates.projectTypeQuestionPayload = normalizeProjectTypeQuestionPayload(
        effectiveProjectTypeId ?? null,
        input.projectTypeQuestionPayload
      );
    }

    const bidDueDateWasProvided = input.bidDueDate !== undefined;
    const normalizedBidDueDate = bidDueDateWasProvided
      ? normalizeOptionalIsoDate(input.bidDueDate, "bidDueDate")
      : null;
    if (bidDueDateWasProvided) {
      updates.bidDueDate = normalizedBidDueDate;
    }

    if (input.status !== undefined) {
      if (input.status === "open" || input.status === "disqualified") {
        updates.status = input.status;
        updates.isActive = input.status === "open";
        // Stamp the disqualification moment so date-scoped surfaces (the leads
        // FilterBar's disqualified axis, lead-date-scope.ts) can window/display on
        // it. Stamp ONLY on the TRANSITION into disqualified — never re-stamp an
        // already-disqualified lead, so its date can't jump to a later window.
        // (In practice a disqualified lead is also inactive and the read-only
        // guard above blocks any further update, so this transition is the only
        // reachable write; the status check makes that invariant explicit.)
        // disqualified_at is the only correct axis here: disqualification does not
        // change the lead's stage, so stage_entered_at is unrelated to it.
        if (input.status === "disqualified" && existing.status !== "disqualified") {
          updates.disqualifiedAt = deps.now();
        }
      } else {
        throw new AppError(400, "Use the conversion endpoint to convert a lead");
      }
    }

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    const updateTime = stageChangedAt ?? deps.now();
    if (assignedRepChanged) {
      updates.ownershipSyncedAt = updateTime;
    }
    updates.updatedAt = updateTime;

    const [lead] = await tenantDb
      .update(leads)
      .set(updates)
      .where(eq(leads.id, leadId))
      .returning();

    const auditFieldChanges = buildRawFieldChanges(
      existing as Record<string, unknown>,
      lead as Record<string, unknown>,
      [
        "stageId",
        "assignedRepId",
        "salesRepId",
        "primaryContactId",
        "projectTypeId",
        "projectType",
        "officeCode",
        "office",
        "name",
        "source",
        "sourceCategory",
        "sourceDetail",
        "description",
        "qualificationPayload",
        "projectTypeQuestionPayload",
        "bidDueDate",
        "status",
        "isActive",
      ]
    );

    if (stageChangeAuditRecord) {
      await tenantDb.insert(leadStageHistory).values(stageChangeAuditRecord);
      await tenantDb.insert(activities).values({
        type: "note",
        responsibleUserId: nextAssignedRepId,
        performedByUserId: userId,
        sourceEntityType: "lead",
        sourceEntityId: existing.id,
        companyId: existing.companyId,
        propertyId: existing.propertyId,
        leadId: existing.id,
        contactId: existing.primaryContactId,
        subject: `Stage changed from ${stageChangeActivityCopy?.fromStageName ?? "previous stage"} to ${
          stageChangeActivityCopy?.toStageName ?? "new stage"
        }`,
        body: `Moved this lead from ${stageChangeActivityCopy?.fromStageName ?? "previous stage"} to ${
          stageChangeActivityCopy?.toStageName ?? "new stage"
        }.`,
        outcome: "lead_stage_changed",
        occurredAt: stageChangedAt ?? updateTime,
      });
    }

    if (input.auditContext && Object.keys(auditFieldChanges).length > 0) {
      await logActivity({
        tenantDb,
        actor: input.auditContext.actor,
        action: "update",
        entity: {
          tableName: "leads",
          entityType: "lead",
          recordId: lead.id,
          nameSnapshot: buildLeadEntityName(
            lead.name,
            (existing as { companyName?: string | null }).companyName
          ),
          secondaryIdSnapshot: null,
        },
        fieldChanges: auditFieldChanges,
        ipAddress: input.auditContext.ipAddress ?? null,
        userAgent: input.auditContext.userAgent ?? null,
      });
    }

    if (
      v2Enabled &&
      ((input.leadQuestionAnswers && Object.keys(input.leadQuestionAnswers).length > 0) || bidDueDateWasProvided)
    ) {
      const activeNodes = await listQuestionnaireNodes(tenantDb);
      const bidDueDateNodeAvailable = activeNodes.some((node) => node.key === "bid_due_date");
      // V2 mirror: lead_question_answers is kept in sync for edit-mode questionnaire UI.
      // Source of truth is leads.bid_due_date. The mirror is best-effort and
      // skipped when bid_due_date is not an active questionnaire node because
      // upsertLeadQuestionAnswerSet rejects unknown keys.
      const v2MirrorAnswers = {
        ...(input.leadQuestionAnswers ?? {}),
        ...(bidDueDateWasProvided && bidDueDateNodeAvailable ? { bid_due_date: normalizedBidDueDate } : {}),
      };
      if (Object.keys(v2MirrorAnswers).length > 0) {
        await upsertLeadQuestionAnswerSet(tenantDb, {
          leadId,
          projectTypeId: effectiveProjectTypeId ?? null,
          changedBy: userId,
          answers: v2MirrorAnswers,
          changedAt: updateTime,
        });
      }
    }

    if (assignedRepChanged) {
      await createAssignmentTaskIfNeeded(tenantDb, {
        entityType: "lead",
        entityId: lead.id,
        entityName: lead.name,
        previousAssignedRepId: existing.assignedRepId,
        nextAssignedRepId,
        actorUserId: userId,
        officeId: input.officeId ?? null,
      });
    }

    return lead;
  }

  async function transitionLeadStage(
    tenantDb: TenantDb,
    input: TransitionLeadStageInput
  ): Promise<TransitionBlockedResult | TransitionSuccessResult> {
    const preflight = await preflightLeadStageCheck(
      tenantDb,
      input.leadId,
      input.targetStageId,
      input.userRole,
      input.userId
    );

    if (!preflight.allowed) {
      return {
        ok: false,
        reason: "missing_requirements",
        code: preflight.blockReason,
        targetStageId: input.targetStageId,
        resolution: "detail",
        missing: preflight.missingRequirements.effectiveChecklist.fields
          .filter((field) => !field.satisfied)
          .map((field) => ({
            key: field.key,
            label: field.label,
            resolution: field.key.startsWith("leadScoping.") ? "detail" : "inline",
          })),
      };
    }

    const lead = await updateLead(
      tenantDb,
      input.leadId,
      {
        ...(input.inlinePatch ?? {}),
        stageId: input.targetStageId,
        officeId: input.officeId,
        auditContext: input.auditContext,
      },
      input.userRole,
      input.userId
    );

    return { ok: true, lead };
  }

  async function deleteLead(
    tenantDb: TenantDb,
    leadId: string,
    opts: {
      actorRole: UserRole;
      actorId?: string | null;
      reason: string;
    }
  ) {
    const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
    if (!reason) {
      throw new AppError(400, "A reason is required to archive a lead.", "LEAD_ARCHIVE_REASON_REQUIRED");
    }

    const lockQuery = tenantDb
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1) as any;
    const rows = typeof lockQuery.for === "function"
      ? await lockQuery.for("update")
      : await lockQuery;
    const existing = rows[0] ?? null;
    if (!existing) {
      throw new AppError(404, "Lead not found");
    }

    if (opts.actorRole !== "admin" && (!opts.actorId || existing.assignedRepId !== opts.actorId)) {
      throw new AppError(
        403,
        "Only the assigned rep or an admin can archive this lead",
        "LEAD_ARCHIVE_FORBIDDEN"
      );
    }

    // Converted/disqualified leads are legitimately inactive and are not archive tombstones.
    if (!existing.isActive && existing.status !== "open") {
      return null;
    }

    const archivedAt = deps.now();
    let lead: typeof existing | null = null;
    if (existing.isActive) {
      const archivedDescription = buildArchivedDescription(existing.description, reason, archivedAt);
      const [updatedLead] = await tenantDb
        .update(leads)
        .set({ isActive: false, description: archivedDescription, updatedAt: archivedAt })
        .where(eq(leads.id, leadId))
        .returning();

      if (!updatedLead) {
        throw new AppError(404, "Lead not found");
      }
      lead = updatedLead;
    }

    // Also reconcile legacy inactive-open tombstones created before archive cleanup existed. Retrying an
    // archive must revoke their pending public token/work without prepending the archive reason a second time.
    await tenantDb
      .update(leadDueDiligenceApprovals)
      .set({
        status: "superseded",
        decidedBy: opts.actorId ?? null,
        decidedAt: archivedAt,
        decisionReason: `Lead archived: ${reason}`,
        updatedAt: archivedAt,
      })
      .where(
        and(
          eq(leadDueDiligenceApprovals.leadId, leadId),
          eq(leadDueDiligenceApprovals.status, "pending")
        )
      );

    // Hidden leads should not leave actionable work behind in dashboards or notification queues.
    await tenantDb
      .update(tasks)
      .set({ status: "dismissed", isOverdue: false })
      .where(
        and(
          sql`${tasks.entitySnapshot} ->> 'leadId' = ${leadId}`,
          inArray(tasks.status, ["pending", "scheduled", "in_progress", "waiting_on", "blocked"])
        )
      );

    return lead;
  }

  return {
    getLeadById,
    listLeads,
    listLeadBoard: listLeadBoardWorkspace,
    listLeadStagePage: listLeadStageWorkspacePage,
    createLead,
    updateLead,
    transitionLeadStage,
    deleteLead,
  };
}

const liveService = createLeadService();

export const getLeadById = liveService.getLeadById;
export const listLeads = liveService.listLeads;
export const listLeadBoard = liveService.listLeadBoard;
export const listLeadStagePage = liveService.listLeadStagePage;
export const createLead = liveService.createLead;
export const updateLead = liveService.updateLead;
export const transitionLeadStage = liveService.transitionLeadStage;
export const deleteLead = liveService.deleteLead;
