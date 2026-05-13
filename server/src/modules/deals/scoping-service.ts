import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealScopingIntake, dealTeamMembers, deals, files, tasks, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { DealScopingIntakeStatus, WorkflowRoute } from "@trock-crm/shared/types";
import { writeAuditLog } from "../../lib/audit-log.js";
import { AppError } from "../../middleware/error-handler.js";
import { getStageById, getStageBySlug } from "../pipeline/service.js";
import { applyProjectTypeChange, BID_BOARD_STAGE_READ_ONLY_MESSAGE } from "./service.js";
import { inferDealBidBoardOwnership, type PlanDealWorkflowBackfillInput } from "./workflow-backfill.js";
import { evaluateScopingReadiness, type DealScopingReadinessSnapshot, type DealScopingSectionData } from "./scoping-rules.js";
import { getResolvedDeal, type ResolvedDealView } from "./lineage-resolver.js";

type TenantDb = NodePgDatabase<typeof schema>;

type DealRow = typeof deals.$inferSelect;
type DealScopingIntakeRow = typeof dealScopingIntake.$inferSelect;

export type DealScopingPatch = {
  projectTypeId?: string | null;
  sectionData?: DealScopingSectionData;
  forceEditAfterRfp?: boolean;
} & Record<string, unknown>;

export interface DealScopingServiceResult {
  intake: DealScopingIntakeRow;
  readiness: DealScopingReadinessResult;
  previousStatus: DealScopingIntakeStatus | null;
  resolved: ResolvedDealView["resolved"];
}

export interface LinkScopingFileInput {
  fileId: string;
  intakeSection: string;
  intakeRequirementKey: string;
  forceEditAfterRfp?: boolean;
}

export interface DealRevisionRoutingResult {
  routed: boolean;
  deal: DealRow;
  task: typeof tasks.$inferSelect | null;
}

export interface DealRevisionRoutingContext {
  proposalStatus?: DealRow["proposalStatus"];
  previousEstimatingSubstage?: DealRow["estimatingSubstage"];
}

export interface DealScopingAttachmentRequirement {
  key: string;
  category: string;
  label: string;
  satisfied: boolean;
}

export interface DealScopingReadinessResult extends DealScopingReadinessSnapshot {
  attachmentRequirements: DealScopingAttachmentRequirement[];
}

interface EvaluateDealScopingReadinessOptions {
  persist?: boolean;
}

type LinkedScopingAttachmentRow = {
  category: unknown;
  intakeRequirementKey: unknown;
  intakeSource: unknown;
  r2Key: unknown;
  r2Bucket: unknown;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSectionData(value: unknown): DealScopingSectionData {
  return isPlainRecord(value) ? { ...value } : {};
}

function mergeSectionData(currentData: DealScopingSectionData, incomingData: DealScopingSectionData): DealScopingSectionData {
  const nextData: DealScopingSectionData = { ...currentData };

  for (const [sectionKey, sectionValue] of Object.entries(incomingData)) {
    if (isPlainRecord(sectionValue) && isPlainRecord(currentData[sectionKey])) {
      nextData[sectionKey] = {
        ...(currentData[sectionKey] as Record<string, unknown>),
        ...sectionValue,
      };
      continue;
    }

    nextData[sectionKey] = sectionValue;
  }

  return nextData;
}

function extractSectionPatch(patch: DealScopingPatch): DealScopingSectionData {
  const directSections = Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) => key !== "workflowRoute" && key !== "projectTypeId" && key !== "sectionData" && isPlainRecord(value)
    )
  );
  const explicitSectionData = toSectionData(patch.sectionData);

  return mergeSectionData(directSections, explicitSectionData);
}

function normalizeText(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDealWritebackPatch(
  patch: Partial<Pick<DealScopingPatch, "projectTypeId" | "workflowRoute">>,
  sectionData: DealScopingSectionData
): Partial<DealRow> {
  const updates: Partial<DealRow> = {};

  if (patch.workflowRoute !== undefined) {
    throw new AppError(400, "Use /api/deals/:id/routing-review for route changes");
  }
  if (patch.projectTypeId !== undefined) {
    updates.projectTypeId = patch.projectTypeId;
  }

  const projectOverview = toSectionData(sectionData.projectOverview);
  const propertyDetails = toSectionData(sectionData.propertyDetails);
  const scopeSummary = toSectionData(sectionData.scopeSummary);

  const propertyName = normalizeText(projectOverview.propertyName);
  if (typeof propertyName === "string") {
    updates.name = propertyName;
  }

  const propertyAddress = normalizeText(propertyDetails.propertyAddress);
  if (propertyAddress !== undefined) {
    updates.propertyAddress = propertyAddress;
  }

  const propertyCity = normalizeText(propertyDetails.propertyCity);
  if (propertyCity !== undefined) {
    updates.propertyCity = propertyCity;
  }

  const propertyState = normalizeText(propertyDetails.propertyState);
  if (propertyState !== undefined) {
    updates.propertyState = propertyState;
  }

  const propertyZip = normalizeText(propertyDetails.propertyZip);
  if (propertyZip !== undefined) {
    updates.propertyZip = propertyZip;
  }

  const summary = normalizeText(scopeSummary.summary);
  if (summary !== undefined) {
    updates.description = summary;
  }

  return updates;
}

function buildSeedSectionDataFromDeal(deal: DealRow): DealScopingSectionData {
  const sectionData: DealScopingSectionData = {};

  if (deal.name) {
    sectionData.projectOverview = {
      propertyName: deal.name,
    };
  }

  if (deal.propertyAddress || deal.propertyCity || deal.propertyState || deal.propertyZip) {
    sectionData.propertyDetails = {
      propertyAddress: deal.propertyAddress,
      propertyCity: deal.propertyCity,
      propertyState: deal.propertyState,
      propertyZip: deal.propertyZip,
    };
  }

  if (deal.description) {
    sectionData.scopeSummary = {
      summary: deal.description,
    };
  }

  return sectionData;
}

function buildSeedSectionDataFromResolvedDeal(resolvedDeal: ResolvedDealView): DealScopingSectionData {
  const sectionData: DealScopingSectionData = {};
  const { resolved } = resolvedDeal;

  if (resolved.propertyName || resolved.bidDueDate) {
    sectionData.projectOverview = {
      propertyName: resolved.propertyName,
      bidDueDate: typeof resolved.bidDueDate === "string" ? resolved.bidDueDate : "",
    };
  }

  if (
    resolved.propertyAddress ||
    resolved.propertyCity ||
    resolved.propertyState ||
    resolved.propertyZip
  ) {
    sectionData.propertyDetails = {
      propertyAddress: resolved.propertyAddress,
      propertyCity: resolved.propertyCity,
      propertyState: resolved.propertyState,
      propertyZip: resolved.propertyZip,
    };
  }

  if (resolved.description) {
    sectionData.scopeSummary = {
      summary: resolved.description,
    };
  }

  return sectionData;
}

function removeKeys(value: unknown, keys: string[]) {
  if (!isPlainRecord(value)) {
    return {};
  }

  const next = { ...value };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function stripLineageOwnedScopingFields(
  sectionData: DealScopingSectionData,
  resolvedDeal: ResolvedDealView
): DealScopingSectionData {
  if (!resolvedDeal.sourceLead) {
    return sectionData;
  }

  const next: DealScopingSectionData = { ...sectionData };
  next.projectOverview = removeKeys(next.projectOverview, ["propertyName", "bidDueDate"]);
  next.propertyDetails = removeKeys(next.propertyDetails, [
    "propertyAddress",
    "propertyCity",
    "propertyState",
    "propertyZip",
  ]);
  next.scopeSummary = removeKeys(next.scopeSummary, ["summary"]);

  return next;
}

function resolveScopingWorkspaceRoute(resolvedDeal: ResolvedDealView): WorkflowRoute {
  return resolvedDeal.resolved.workflowRoute;
}

function buildBaseSectionData(
  existingIntake: DealScopingIntakeRow | null,
  resolvedDeal: ResolvedDealView
): DealScopingSectionData {
  return mergeSectionData(
    buildSeedSectionDataFromResolvedDeal(resolvedDeal),
    stripLineageOwnedScopingFields(toSectionData(existingIntake?.sectionData), resolvedDeal)
  );
}

async function getDealOrThrow(tenantDb: TenantDb, dealId: string) {
  const [deal] = await tenantDb.select().from(deals).where(eq(deals.id, dealId)).limit(1);

  if (!deal) {
    throw new AppError(404, "Deal not found");
  }

  return deal;
}

function buildBidBoardOwnershipInput(
  deal: DealRow,
  currentStage: Awaited<ReturnType<typeof getStageById>>
): PlanDealWorkflowBackfillInput {
  return {
    id: deal.id,
    stageSlug: currentStage?.slug ?? null,
    stageEnteredAt: deal.stageEnteredAt,
    workflowRoute: deal.workflowRoute,
    pipelineTypeSnapshot: deal.pipelineTypeSnapshot,
    ddEstimate: deal.ddEstimate,
    bidEstimate: deal.bidEstimate,
    awardedAmount: deal.awardedAmount,
    sourceLeadId: deal.sourceLeadId,
    isBidBoardOwned: deal.isBidBoardOwned,
    bidBoardStageSlug: deal.bidBoardStageSlug,
    bidBoardStageEnteredAt: deal.bidBoardStageEnteredAt,
    bidBoardMirrorSourceEnteredAt: deal.bidBoardMirrorSourceEnteredAt,
    isReadOnlyMirror: deal.isReadOnlyMirror,
    readOnlySyncedAt: deal.readOnlySyncedAt,
  };
}

async function assertDealScopingEditable(deal: DealRow) {
  const currentStage = await getStageById(deal.stageId);
  const ownership = inferDealBidBoardOwnership(buildBidBoardOwnershipInput(deal, currentStage));

  if (!ownership.reopenInCrmEditableFlow) {
    throw new AppError(
      403,
      BID_BOARD_STAGE_READ_ONLY_MESSAGE,
      "BID_BOARD_OWNED_STAGE_READ_ONLY"
    );
  }
}

async function resolveDealScopeLockState(deal: DealRow) {
  const currentStage = await getStageById(deal.stageId);
  const opportunityStage =
    currentStage?.workflowFamily === "standard_deal" ||
    currentStage?.workflowFamily === "service_deal"
      ? await getStageBySlug("opportunity", currentStage.workflowFamily)
      : null;
  const isPastOpportunity =
    Boolean(currentStage && opportunityStage && currentStage.displayOrder > opportunityStage.displayOrder);
  const hasRfpSubmission =
    deal.rfpApprovalRequestedAt != null || Boolean(deal.rfpApprovalStatus);
  const hasBidBoardHandoff =
    deal.bidBoardLinkedAt != null ||
    Boolean(deal.bidBoardProjectNumber) ||
    inferDealBidBoardOwnership(buildBidBoardOwnershipInput(deal, currentStage)).isBidBoardOwned;

  return {
    locked: hasRfpSubmission || hasBidBoardHandoff || isPastOpportunity,
    submittedAt: deal.rfpApprovalRequestedAt ?? deal.bidBoardLinkedAt ?? deal.readOnlySyncedAt ?? null,
    reason: hasRfpSubmission
      ? "rfp_submission"
      : hasBidBoardHandoff
        ? "bid_board_handoff"
        : isPastOpportunity
          ? "past_opportunity"
          : null,
  };
}

async function assertDealScopingWriteAllowedForDeal(
  deal: DealRow,
  input: {
    role?: string | null;
    forceEditAfterRfp?: boolean;
  }
) {
  const lockState = await resolveDealScopeLockState(deal);
  if (lockState.locked) {
    if (input.role === "admin" && input.forceEditAfterRfp === true) {
      return { adminOverride: true, lockState };
    }

    throw new AppError(
      403,
      "Scope is read-only after RFP submission",
      "SCOPE_READ_ONLY_AFTER_RFP"
    );
  }

  await assertDealScopingEditable(deal);
  return { adminOverride: false, lockState };
}

export async function assertDealScopingWriteAllowed(
  tenantDb: TenantDb,
  dealId: string,
  input: {
    role?: string | null;
    forceEditAfterRfp?: boolean;
  }
) {
  const deal = await getDealOrThrow(tenantDb, dealId);
  return assertDealScopingWriteAllowedForDeal(deal, input);
}

async function getUserOrThrow(tenantDb: TenantDb, userId: string) {
  const [user] = await tenantDb.select().from(users).where(eq(users.id, userId)).limit(1);

  if (!user) {
    throw new AppError(404, "User not found");
  }

  return user;
}

async function getExistingIntake(tenantDb: TenantDb, dealId: string) {
  const [intake] = await tenantDb
    .select()
    .from(dealScopingIntake)
    .where(eq(dealScopingIntake.dealId, dealId))
    .limit(1);

  return intake ?? null;
}

async function buildReadOnlyScopingIntakeSnapshot(input: {
  tenantDb: TenantDb;
  resolvedDeal: ResolvedDealView;
  userId: string;
}): Promise<DealScopingServiceResult> {
  const [user, attachments] = await Promise.all([
    getUserOrThrow(input.tenantDb, input.userId),
    listLinkedScopingAttachments(input.tenantDb, input.resolvedDeal.deal.id),
  ]);
  const sectionData = buildSeedSectionDataFromResolvedDeal(input.resolvedDeal);
  const projectTypeId = input.resolvedDeal.resolved.projectTypeId ?? null;
  const workflowRoute = resolveScopingWorkflowRoute(input.resolvedDeal.resolved.workflowRoute);
  const readiness = buildScopingReadiness({
    currentStatus: "draft",
    workflowRoute,
    projectTypeId,
    sectionData,
    attachments,
  });
  const timestamp =
    input.resolvedDeal.deal.rfpApprovalRequestedAt ??
    input.resolvedDeal.deal.bidBoardLinkedAt ??
    input.resolvedDeal.deal.readOnlySyncedAt ??
    input.resolvedDeal.deal.updatedAt ??
    new Date();

  return {
    intake: {
      id: `readonly-${input.resolvedDeal.deal.id}`,
      dealId: input.resolvedDeal.deal.id,
      officeId: user.officeId,
      workflowRouteSnapshot: workflowRoute,
      status: readiness.status,
      projectTypeId,
      sectionData,
      completionState: readiness.completionState,
      readinessErrors: readiness.errors,
      firstReadyAt: null,
      activatedAt: null,
      lastAutosavedAt: timestamp,
      createdBy: input.userId,
      lastEditedBy: input.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as DealScopingIntakeRow,
    readiness,
    previousStatus: null,
    resolved: input.resolvedDeal.resolved,
  };
}

export async function getOrCreateDealScopingIntake(
  tenantDb: TenantDb,
  dealId: string,
  userId: string
): Promise<DealScopingServiceResult> {
  const existingIntake = await getExistingIntake(tenantDb, dealId);

  if (existingIntake) {
    const resolvedDeal = await getResolvedDeal(tenantDb, dealId);
    const readiness = await evaluateDealScopingReadiness(tenantDb, dealId);
    const refreshedIntake = (await getExistingIntake(tenantDb, dealId)) ?? existingIntake;

    return {
      intake: refreshedIntake,
      readiness,
      previousStatus: existingIntake.status as DealScopingIntakeStatus,
      resolved: resolvedDeal.resolved,
    };
  }

  const resolvedDeal = await getResolvedDeal(tenantDb, dealId);
  const deal = resolvedDeal.deal;
  const lockState = await resolveDealScopeLockState(deal);
  if (lockState.locked) {
    return buildReadOnlyScopingIntakeSnapshot({ tenantDb, resolvedDeal, userId });
  }
  await assertDealScopingWriteAllowedForDeal(deal, { role: "system" });
  const initialPatch: DealScopingPatch = {
    sectionData: buildSeedSectionDataFromResolvedDeal(resolvedDeal),
  };
  if (resolvedDeal.resolved.projectTypeId != null) {
    initialPatch.projectTypeId = resolvedDeal.resolved.projectTypeId;
  }

  return upsertDealScopingIntake(
    tenantDb,
    dealId,
    initialPatch,
    userId
  );
}

async function listLinkedScopingAttachments(
  tenantDb: TenantDb,
  dealId: string
): Promise<LinkedScopingAttachmentRow[]> {
  const rows = await tenantDb
    .select({
      category: files.category,
      intakeRequirementKey: files.intakeRequirementKey,
      intakeSource: files.intakeSource,
      r2Key: files.r2Key,
      r2Bucket: files.r2Bucket,
    })
    .from(files)
    .where(and(eq(files.dealId, dealId), eq(files.isActive, true)));

  return rows;
}

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveScopingWorkflowRoute(
  workflowRoute: WorkflowRoute | null | undefined
): WorkflowRoute {
  return workflowRoute ?? "normal";
}

function getRequiredScopingAttachmentRequirements(
  workflowRoute: WorkflowRoute
): DealScopingAttachmentRequirement[] {
  if (workflowRoute === "service") {
    return [
      {
        key: "site_photos",
        category: "photo",
        label: "Site photos",
        satisfied: false,
      },
    ];
  }

  return [
    {
      key: "scope_docs",
      category: "other",
      label: "Scope docs",
      satisfied: false,
    },
    {
      key: "site_photos",
      category: "photo",
      label: "Site photos",
      satisfied: false,
    },
  ];
}

function isVerifiedLinkedScopingAttachment(file: LinkedScopingAttachmentRow) {
  return (
    hasNonEmptyText(file.category) &&
    hasNonEmptyText(file.intakeRequirementKey) &&
    file.intakeSource === "scoping_intake" &&
    hasNonEmptyText(file.r2Key) &&
    hasNonEmptyText(file.r2Bucket)
  );
}

function buildScopingReadiness(input: {
  currentStatus: DealScopingIntakeStatus;
  workflowRoute: WorkflowRoute;
  projectTypeId: string | null;
  sectionData: DealScopingSectionData;
  attachments: LinkedScopingAttachmentRow[];
}): DealScopingReadinessResult {
  const baseReadiness = evaluateScopingReadiness({
    currentStatus: input.currentStatus,
    workflowRoute: input.workflowRoute,
    projectTypeId: input.projectTypeId,
    sectionData: input.sectionData,
    attachmentKeys: [],
  });
  const requiredAttachments = getRequiredScopingAttachmentRequirements(input.workflowRoute);
  const verifiedLinkedAttachments = input.attachments.filter(isVerifiedLinkedScopingAttachment);
  const attachmentRequirements = requiredAttachments.map((requirement) => ({
    ...requirement,
    satisfied: verifiedLinkedAttachments.some(
      (attachment) =>
        attachment.intakeRequirementKey === requirement.key &&
        attachment.category === requirement.category
    ),
  }));
  const missingAttachments = attachmentRequirements.filter(
    (requirement) => !requirement.satisfied
  );
  const hasSectionErrors = Object.values(baseReadiness.errors.sections).some(
    (fields) => fields.length > 0
  );

  return {
    ...baseReadiness,
    status:
      input.currentStatus === "activated"
        ? "activated"
        : hasSectionErrors || missingAttachments.length > 0
          ? "draft"
          : "ready",
    errors: {
      ...baseReadiness.errors,
      attachments: Object.fromEntries(
        missingAttachments.map((requirement) => [requirement.key, [requirement.key]])
      ),
    },
    completionState: {
      ...baseReadiness.completionState,
      attachments: {
        isComplete: missingAttachments.length === 0,
        missingFields: [],
        missingAttachments: missingAttachments.map((requirement) => requirement.key),
      },
    },
    requiredAttachmentKeys: attachmentRequirements.map((requirement) => requirement.key),
    attachmentRequirements,
  };
}

export async function linkDealFileToScopingRequirement(
  tenantDb: TenantDb,
  dealId: string,
  input: LinkScopingFileInput,
  userId: string
) {
  const [deal, user] = await Promise.all([
    getDealOrThrow(tenantDb, dealId),
    getUserOrThrow(tenantDb, userId),
  ]);
  const writePolicy = await assertDealScopingWriteAllowedForDeal(deal, {
    role: user.role,
    forceEditAfterRfp: input.forceEditAfterRfp,
  });

  const [file] = await tenantDb
    .select()
    .from(files)
    .where(and(eq(files.id, input.fileId), eq(files.isActive, true)))
    .limit(1);

  if (!file) {
    throw new AppError(404, "File not found");
  }

  if (file.dealId !== deal.id) {
    throw new AppError(400, "File must belong to the same deal to be linked into scoping");
  }

  const [updatedFile] = await tenantDb
    .update(files)
    .set({
      intakeSection: input.intakeSection,
      intakeRequirementKey: input.intakeRequirementKey,
      intakeSource: "scoping_intake",
      updatedAt: new Date(),
    })
    .where(eq(files.id, input.fileId))
    .returning();

  if (!updatedFile) {
    throw new AppError(500, "Failed to update file scoping metadata");
  }

  if (writePolicy.adminOverride) {
    await writeAuditLog(tenantDb, {
      tableName: "deal_scoping_intake",
      recordId: dealId,
      action: "update",
      changedBy: userId,
      changes: {
        linkedFileId: {
          from: null,
          to: updatedFile.id,
        },
      },
      fullRow: {
        override: "admin_force_edit_after_rfp",
        reason: writePolicy.lockState.reason,
        fileId: updatedFile.id,
        intakeRequirementKey: input.intakeRequirementKey,
      },
    });
  }

  return updatedFile;
}

function createIntakePayload(input: {
  existingIntake: DealScopingIntakeRow | null;
  deal: DealRow;
  userId: string;
  editorOfficeId: string;
  route: WorkflowRoute;
  projectTypeId: string | null;
  sectionData: DealScopingSectionData;
  readiness: DealScopingReadinessResult;
}) {
  const now = new Date();
  const firstReadyAt =
    input.readiness.status === "draft"
      ? null
      : input.existingIntake?.firstReadyAt ?? now;

  return {
    officeId: input.existingIntake?.officeId ?? input.editorOfficeId,
    workflowRouteSnapshot: input.route,
    status: input.readiness.status,
    projectTypeId: input.projectTypeId,
    sectionData: input.sectionData,
    completionState: input.readiness.completionState,
    readinessErrors: input.readiness.errors,
    firstReadyAt,
    activatedAt: input.existingIntake?.activatedAt ?? null,
    lastAutosavedAt: now,
    lastEditedBy: input.userId,
    updatedAt: now,
  };
}

async function persistReadinessIfNeeded(
  tenantDb: TenantDb,
  intake: DealScopingIntakeRow | null,
  payload: ReturnType<typeof createIntakePayload>
) {
  if (!intake) {
    return null;
  }

  const [savedIntake] = await tenantDb
    .update(dealScopingIntake)
    .set(payload)
    .where(eq(dealScopingIntake.id, intake.id))
    .returning();

  return savedIntake ?? null;
}

export async function evaluateDealScopingReadiness(
  tenantDb: TenantDb,
  dealId: string,
  options: EvaluateDealScopingReadinessOptions = {}
): Promise<DealScopingReadinessResult> {
  const resolvedDeal = await getResolvedDeal(tenantDb, dealId);
  const deal = resolvedDeal.deal;
  const existingIntake = await getExistingIntake(tenantDb, dealId);
  const attachments = await listLinkedScopingAttachments(tenantDb, dealId);
  const sectionData = buildBaseSectionData(existingIntake, resolvedDeal);
  const projectTypeId = existingIntake?.projectTypeId ?? resolvedDeal.resolved.projectTypeId ?? null;
  const workflowRoute = resolveScopingWorkflowRoute(resolvedDeal.resolved.workflowRoute);
  const readiness = buildScopingReadiness({
    currentStatus: (existingIntake?.status ?? "draft") as DealScopingIntakeStatus,
    workflowRoute,
    projectTypeId,
    sectionData,
    attachments,
  });

  const lockState = await resolveDealScopeLockState(deal);
  const shouldPersist = options.persist !== false && !lockState.locked;
  if (existingIntake && shouldPersist) {
    const user = await getUserOrThrow(tenantDb, existingIntake.lastEditedBy);
    await persistReadinessIfNeeded(
      tenantDb,
      existingIntake,
      createIntakePayload({
        existingIntake,
        deal,
        userId: existingIntake.lastEditedBy,
        editorOfficeId: user.officeId,
        route: workflowRoute,
        projectTypeId,
        sectionData,
        readiness,
      })
    );
  }

  return readiness;
}

export async function activateDealScopingIntake(
  tenantDb: TenantDb,
  dealId: string
): Promise<DealScopingServiceResult> {
  const deal = await getDealOrThrow(tenantDb, dealId);
  await assertDealScopingWriteAllowedForDeal(deal, { role: "system" });
  const existingIntake = await getExistingIntake(tenantDb, dealId);

  if (!existingIntake) {
    throw new AppError(400, "Scoping intake is incomplete. Complete all required scoping items before activating workflow.");
  }

  const readiness = await evaluateDealScopingReadiness(tenantDb, dealId);
  if (readiness.status === "draft") {
    throw new AppError(400, "Scoping intake is incomplete. Complete all required scoping items before activating workflow.");
  }

  const now = new Date();
  const workflowRoute = resolveScopingWorkflowRoute(deal.workflowRoute);
  const [savedIntake] = await tenantDb
    .update(dealScopingIntake)
    .set({
      workflowRouteSnapshot: workflowRoute,
      status: "activated",
      activatedAt: existingIntake.activatedAt ?? now,
      updatedAt: now,
      lastAutosavedAt: existingIntake.lastAutosavedAt ?? now,
    })
    .where(eq(dealScopingIntake.id, existingIntake.id))
    .returning();

  if (!savedIntake) {
    throw new AppError(500, "Failed to activate deal scoping intake");
  }

  return {
    intake: savedIntake,
    readiness: { ...readiness, status: "activated" },
    previousStatus: existingIntake.status as DealScopingIntakeStatus,
    resolved: (await getResolvedDeal(tenantDb, dealId)).resolved,
  };
}

export async function upsertDealScopingIntake(
  tenantDb: TenantDb,
  dealId: string,
  patch: DealScopingPatch,
  userId: string
): Promise<DealScopingServiceResult> {
  const sanitizedPatch = { ...patch };
  const forceEditAfterRfp = sanitizedPatch.forceEditAfterRfp === true;
  delete sanitizedPatch.workflowRoute;
  delete sanitizedPatch.forceEditAfterRfp;

  const [resolvedDeal, editor, existingIntake] = await Promise.all([
    getResolvedDeal(tenantDb, dealId),
    getUserOrThrow(tenantDb, userId),
    getExistingIntake(tenantDb, dealId),
  ]);
  const deal = resolvedDeal.deal;
  const writePolicy = await assertDealScopingWriteAllowedForDeal(deal, {
    role: editor.role,
    forceEditAfterRfp,
  });
  const baseSectionData = buildBaseSectionData(existingIntake, resolvedDeal);
  const sectionPatch = stripLineageOwnedScopingFields(
    extractSectionPatch(sanitizedPatch),
    resolvedDeal
  );
  const nextSectionData = mergeSectionData(
    baseSectionData,
    sectionPatch
  );
  const dealUpdates = buildDealWritebackPatch(sanitizedPatch, nextSectionData);
  if (!resolvedDeal.sourceLead && sanitizedPatch.projectTypeId !== undefined) {
    Object.assign(
      dealUpdates,
      await applyProjectTypeChange(tenantDb, deal, sanitizedPatch.projectTypeId, {
        id: userId,
        role: editor.role,
      })
    );
  }

  if (Object.keys(dealUpdates).length > 0) {
    await tenantDb
      .update(deals)
      .set({
        ...dealUpdates,
        updatedAt: new Date(),
      })
      .where(eq(deals.id, dealId))
      .returning();
  }

  const nextRoute = resolveScopingWorkspaceRoute(resolvedDeal);
  const projectTypeId =
    resolvedDeal.sourceLead
      ? resolvedDeal.resolved.projectTypeId ?? null
      : sanitizedPatch.projectTypeId === undefined
      ? existingIntake?.projectTypeId ?? resolvedDeal.resolved.projectTypeId ?? null
      : sanitizedPatch.projectTypeId;
  const attachments = await listLinkedScopingAttachments(tenantDb, dealId);
  const readiness = buildScopingReadiness({
    currentStatus: (existingIntake?.status ?? "draft") as DealScopingIntakeStatus,
    workflowRoute: nextRoute,
    projectTypeId,
    sectionData: nextSectionData,
    attachments,
  });
  const payload = createIntakePayload({
    existingIntake,
    deal: {
      ...deal,
      ...dealUpdates,
      projectTypeId,
    },
    userId,
    editorOfficeId: editor.officeId,
    route: nextRoute,
    projectTypeId,
    sectionData: nextSectionData,
    readiness,
  });

  const savedIntake = existingIntake
    ? await persistReadinessIfNeeded(tenantDb, existingIntake, payload)
    : (
        await tenantDb
          .insert(dealScopingIntake)
          .values({
            dealId,
            createdBy: userId,
            createdAt: new Date(),
            ...payload,
          })
          .returning()
      )[0] ?? null;

  if (!savedIntake) {
    throw new AppError(500, "Failed to save deal scoping intake");
  }

  if (writePolicy.adminOverride) {
    await writeAuditLog(tenantDb, {
      tableName: "deal_scoping_intake",
      recordId: dealId,
      action: "update",
      changedBy: userId,
      changes: {
        readOnlyOverride: {
          from: false,
          to: true,
        },
      },
      fullRow: {
        override: "admin_force_edit_after_rfp",
        reason: writePolicy.lockState.reason,
        submittedAt: writePolicy.lockState.submittedAt instanceof Date
          ? writePolicy.lockState.submittedAt.toISOString()
          : writePolicy.lockState.submittedAt,
      },
    });
  }

  return {
    intake: savedIntake,
    readiness,
    previousStatus: existingIntake?.status as DealScopingIntakeStatus | null ?? null,
    resolved: (await getResolvedDeal(tenantDb, dealId)).resolved,
  };
}

async function resolveRevisionTaskAssignee(
  tenantDb: TenantDb,
  deal: DealRow
): Promise<string> {
  const teamMembers = await tenantDb
    .select()
    .from(dealTeamMembers)
    .where(eq(dealTeamMembers.dealId, deal.id));

  const [estimator] = teamMembers
    .filter(
      (member) =>
        member.dealId === deal.id &&
        member.role === "estimator" &&
        member.isActive
    )
    .sort((left, right) => {
      const leftCreatedAt =
        left.createdAt instanceof Date ? left.createdAt.getTime() : Number.MAX_SAFE_INTEGER;
      const rightCreatedAt =
        right.createdAt instanceof Date ? right.createdAt.getTime() : Number.MAX_SAFE_INTEGER;

      if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
      }

      if (left.userId !== right.userId) {
        return left.userId.localeCompare(right.userId);
      }

      return left.id.localeCompare(right.id);
    });

  return estimator?.userId ?? deal.assignedRepId;
}

export async function routeRevisionToEstimating(
  tenantDb: TenantDb,
  dealId: string,
  userId: string,
  context?: DealRevisionRoutingContext
): Promise<DealRevisionRoutingResult> {
  const [deal, editor] = await Promise.all([
    getDealOrThrow(tenantDb, dealId),
    getUserOrThrow(tenantDb, userId),
  ]);
  const targetProposalStatus = context?.proposalStatus ?? deal.proposalStatus;
  const routingSubstage =
    context?.previousEstimatingSubstage ?? deal.estimatingSubstage;

  if (
    deal.workflowRoute !== "normal" ||
    targetProposalStatus !== "revision_requested" ||
    routingSubstage !== "sent_to_client"
  ) {
    return {
      routed: false,
      deal,
      task: null,
    };
  }

  const [updatedDeal] = await tenantDb
    .update(deals)
    .set({
      estimatingSubstage: "building_estimate",
      updatedAt: new Date(),
    })
    .where(eq(deals.id, dealId))
    .returning();

  const routedDeal = (updatedDeal ?? {
    ...deal,
    estimatingSubstage: "building_estimate",
  }) as DealRow;
  const assignedTo = await resolveRevisionTaskAssignee(tenantDb, routedDeal);
  const revisionCount =
    typeof routedDeal.proposalRevisionCount === "number"
      ? routedDeal.proposalRevisionCount
      : 0;
  const title = `Address estimate revision for ${routedDeal.name}`;

  const [task] = await tenantDb
    .insert(tasks)
    .values({
      title,
      description:
        "Client feedback sent this deal back into estimating. Review the requested changes and prepare a revised estimate.",
      type: "system",
      priority: "high",
      status: "pending",
      assignedTo,
      createdBy: userId,
      officeId: editor.officeId,
      originRule: "deal_estimate_revision_requested",
      sourceRule: "deal_estimate_revision_requested",
      sourceEvent: "deal.estimate.revision_requested",
      dedupeKey: `deal:${dealId}:estimate_revision:${revisionCount}`,
      reasonCode: "deal_estimate_revision_requested",
      dealId,
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "deal",
        entityId: dealId,
        officeId: editor.officeId,
        sourceEvent: "deal.estimate.revision_requested",
        dealId,
        dealName: routedDeal.name,
        dealNumber: routedDeal.dealNumber ?? null,
        summary: title,
      },
    })
    .returning();

  return {
    routed: true,
    deal: routedDeal,
    task: task ?? null,
  };
}
