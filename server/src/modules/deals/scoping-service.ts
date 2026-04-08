import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealScopingIntake, deals, files, users } from "@trock-crm/shared/schema";
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
}

export interface LinkScopingFileInput {
  fileId: string;
  intakeSection: string;
  intakeRequirementKey: string;
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
    };
  }

  return upsertDealScopingIntake(tenantDb, dealId, {}, userId);
}

async function listAttachmentRequirementKeys(tenantDb: TenantDb, dealId: string): Promise<string[]> {
  const rows = await tenantDb
    .select()
    .from(files)
    .where(and(eq(files.dealId, dealId), eq(files.isActive, true)));

  return rows
    .map((row) => row.intakeRequirementKey)
    .filter((requirementKey): requirementKey is string => typeof requirementKey === "string");
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
  const attachmentKeys = await listAttachmentRequirementKeys(tenantDb, dealId);
  const sectionData = toSectionData(existingIntake?.sectionData);
  const projectTypeId = existingIntake?.projectTypeId ?? deal.projectTypeId ?? null;
  const readiness = evaluateScopingReadiness({
    currentStatus: (existingIntake?.status ?? "draft") as DealScopingIntakeStatus,
    workflowRoute: deal.workflowRoute,
    projectTypeId,
    sectionData,
    attachmentKeys,
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
  const nextSectionData = mergeSectionData(
    toSectionData(existingIntake?.sectionData),
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
  const attachmentKeys = await listAttachmentRequirementKeys(tenantDb, dealId);
  const readiness = evaluateScopingReadiness({
    currentStatus: (existingIntake?.status ?? "draft") as DealScopingIntakeStatus,
    workflowRoute: nextRoute,
    projectTypeId,
    sectionData: nextSectionData,
    attachmentKeys,
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
  };
}
