import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealScopingIntake, dealTeamMembers, deals, files, tasks, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { DealScopingIntakeStatus, WorkflowRoute } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { evaluateScopingReadiness, type DealScopingReadinessSnapshot, type DealScopingSectionData } from "./scoping-rules.js";

type TenantDb = NodePgDatabase<typeof schema>;

type DealRow = typeof deals.$inferSelect;
type DealScopingIntakeRow = typeof dealScopingIntake.$inferSelect;

export type DealScopingPatch = {
  workflowRoute?: WorkflowRoute;
  projectTypeId?: string | null;
  sectionData?: DealScopingSectionData;
} & Record<string, unknown>;

export interface DealScopingServiceResult {
  intake: DealScopingIntakeRow;
  readiness: DealScopingReadinessSnapshot;
  previousStatus: DealScopingIntakeStatus | null;
}

export interface LinkScopingFileInput {
  fileId: string;
  intakeSection: string;
  intakeRequirementKey: string;
}

export interface DealRevisionRoutingResult {
  routed: boolean;
  deal: DealRow;
  task: typeof tasks.$inferSelect | null;
}

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
  patch: Pick<DealScopingPatch, "workflowRoute" | "projectTypeId">,
  sectionData: DealScopingSectionData
): Partial<DealRow> {
  const updates: Partial<DealRow> = {};

  if (patch.workflowRoute !== undefined) {
    updates.workflowRoute = patch.workflowRoute;
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

function buildBaseSectionData(
  existingIntake: DealScopingIntakeRow | null,
  deal: DealRow
): DealScopingSectionData {
  return mergeSectionData(
    buildSeedSectionDataFromDeal(deal),
    toSectionData(existingIntake?.sectionData)
  );
}

async function getDealOrThrow(tenantDb: TenantDb, dealId: string) {
  const [deal] = await tenantDb.select().from(deals).where(eq(deals.id, dealId)).limit(1);

  if (!deal) {
    throw new AppError(404, "Deal not found");
  }

  return deal;
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

export async function getOrCreateDealScopingIntake(
  tenantDb: TenantDb,
  dealId: string,
  userId: string
): Promise<DealScopingServiceResult> {
  const existingIntake = await getExistingIntake(tenantDb, dealId);

  if (existingIntake) {
    const readiness = await evaluateDealScopingReadiness(tenantDb, dealId);
    const refreshedIntake = (await getExistingIntake(tenantDb, dealId)) ?? existingIntake;

    return {
      intake: refreshedIntake,
      readiness,
      previousStatus: existingIntake.status as DealScopingIntakeStatus,
    };
  }

  const deal = await getDealOrThrow(tenantDb, dealId);

  return upsertDealScopingIntake(
    tenantDb,
    dealId,
    {
      projectTypeId: deal.projectTypeId,
      sectionData: buildSeedSectionDataFromDeal(deal),
    },
    userId
  );
}

async function listLinkedScopingAttachments(
  tenantDb: TenantDb,
  dealId: string
): Promise<Array<{ requirementKey: string | null; category: string | null }>> {
  const rows = await tenantDb
    .select({
      category: files.category,
      intakeRequirementKey: files.intakeRequirementKey,
    })
    .from(files)
    .where(and(eq(files.dealId, dealId), eq(files.isActive, true)));

  return rows.map((row) => ({
    requirementKey:
      typeof row.intakeRequirementKey === "string" ? row.intakeRequirementKey : null,
    category: typeof row.category === "string" ? row.category : null,
  }));
}

export async function linkDealFileToScopingRequirement(
  tenantDb: TenantDb,
  dealId: string,
  input: LinkScopingFileInput,
  userId: string
) {
  const deal = await getDealOrThrow(tenantDb, dealId);
  await getUserOrThrow(tenantDb, userId);

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
  readiness: DealScopingReadinessSnapshot;
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
  dealId: string
): Promise<DealScopingReadinessSnapshot> {
  const deal = await getDealOrThrow(tenantDb, dealId);
  const existingIntake = await getExistingIntake(tenantDb, dealId);
  const attachments = await listLinkedScopingAttachments(tenantDb, dealId);
  const sectionData = buildBaseSectionData(existingIntake, deal);
  const projectTypeId = existingIntake?.projectTypeId ?? deal.projectTypeId ?? null;
  const readiness = evaluateScopingReadiness({
    currentStatus: (existingIntake?.status ?? "draft") as DealScopingIntakeStatus,
    workflowRoute: deal.workflowRoute,
    projectTypeId,
    sectionData,
    attachments,
  });

  if (existingIntake) {
    const user = await getUserOrThrow(tenantDb, existingIntake.lastEditedBy);
    await persistReadinessIfNeeded(
      tenantDb,
      existingIntake,
      createIntakePayload({
        existingIntake,
        deal,
        userId: existingIntake.lastEditedBy,
        editorOfficeId: user.officeId,
        route: deal.workflowRoute,
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
  const existingIntake = await getExistingIntake(tenantDb, dealId);

  if (!existingIntake) {
    throw new AppError(400, "Scoping intake is incomplete. Complete all required scoping items before activating workflow.");
  }

  const readiness = await evaluateDealScopingReadiness(tenantDb, dealId);
  if (readiness.status === "draft") {
    throw new AppError(400, "Scoping intake is incomplete. Complete all required scoping items before activating workflow.");
  }

  const now = new Date();
  const [savedIntake] = await tenantDb
    .update(dealScopingIntake)
    .set({
      workflowRouteSnapshot: deal.workflowRoute,
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
  };
}

export async function upsertDealScopingIntake(
  tenantDb: TenantDb,
  dealId: string,
  patch: DealScopingPatch,
  userId: string
): Promise<DealScopingServiceResult> {
  const [deal, editor, existingIntake] = await Promise.all([
    getDealOrThrow(tenantDb, dealId),
    getUserOrThrow(tenantDb, userId),
    getExistingIntake(tenantDb, dealId),
  ]);
  const baseSectionData = buildBaseSectionData(existingIntake, deal);
  const nextSectionData = mergeSectionData(
    baseSectionData,
    extractSectionPatch(patch)
  );
  const dealUpdates = buildDealWritebackPatch(patch, nextSectionData);

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

  const nextRoute = patch.workflowRoute ?? dealUpdates.workflowRoute ?? deal.workflowRoute;
  const projectTypeId =
    patch.projectTypeId === undefined
      ? existingIntake?.projectTypeId ?? deal.projectTypeId ?? null
      : patch.projectTypeId;
  const attachments = await listLinkedScopingAttachments(tenantDb, dealId);
  const readiness = evaluateScopingReadiness({
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
      workflowRoute: nextRoute,
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

  return {
    intake: savedIntake,
    readiness,
    previousStatus: existingIntake?.status as DealScopingIntakeStatus | null ?? null,
  };
}

async function resolveRevisionTaskAssignee(
  tenantDb: TenantDb,
  deal: DealRow
): Promise<string> {
  const [estimator] = await tenantDb
    .select()
    .from(dealTeamMembers)
    .where(
      and(
        eq(dealTeamMembers.dealId, deal.id),
        eq(dealTeamMembers.role, "estimator"),
        eq(dealTeamMembers.isActive, true)
      )
    )
    .limit(1);

  return estimator?.userId ?? deal.assignedRepId;
}

export async function routeRevisionToEstimating(
  tenantDb: TenantDb,
  dealId: string,
  userId: string
): Promise<DealRevisionRoutingResult> {
  const [deal, editor] = await Promise.all([
    getDealOrThrow(tenantDb, dealId),
    getUserOrThrow(tenantDb, userId),
  ]);

  if (
    deal.workflowRoute !== "estimating" ||
    deal.proposalStatus !== "revision_requested" ||
    deal.estimatingSubstage !== "sent_to_client"
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
