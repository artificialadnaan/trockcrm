import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, deals, files, leads } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { toCanonicalLeadStageSlug, type FileCategory, type WorkflowRoute } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { createDeal } from "../deals/service.js";
import { getStageById, getStageBySlug } from "../pipeline/service.js";
import {
  isAnsweredQuestionValue,
  isLeadEditV2Enabled,
  applyLeadAttachmentAnswers,
  listLeadQuestionAnswers,
  listMissingRequiredQuestionKeys,
  listQuestionnaireNodes,
} from "./questionnaire-service.js";
import { LeadStageTransitionError } from "./stage-transition-service.js";
import { computeExistingCustomerStatus } from "../companies/customer-status-service.js";
import { resolveLeadSourceDisplayValue } from "./source-control.js";
import { logActivity, type AuditContext } from "../audit/audit-logger.js";

// The rep's gated lead estimate (leads.qualification_payload.estimated_value) is stored
// as free-form JSON (number on save, but treat as unknown). Coerce it to a positive
// numeric string suitable for a deal estimate column, or undefined when absent/invalid.
// Maps to a pipeline estimate (dd/bid) only -- NEVER awarded_amount (the Won amount).
function normalizeLeadEstimatedValue(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const numeric = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return String(numeric);
}

type TenantDb = NodePgDatabase<typeof schema>;

const CLIENT_PROVIDED_DOCS_TAG = "client_provided_docs";
const IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"]);

export function resolveLeadAttachmentConversionMetadata(file: {
  originalFilename: string;
  mimeType: string;
  category: string;
  tags: string[];
}): {
  category: FileCategory | string;
  intakeSection: "attachments" | null;
  intakeRequirementKey: "scope_docs" | "site_photos" | null;
  intakeSource: "scoping_intake" | null;
} {
  const isClientProvidedDocs = file.tags.some((tag) => tag.toLowerCase() === CLIENT_PROVIDED_DOCS_TAG);
  if (!isClientProvidedDocs) {
    return {
      category: file.category,
      intakeSection: null,
      intakeRequirementKey: null,
      intakeSource: null,
    };
  }

  const extension = file.originalFilename.lastIndexOf(".") >= 0
    ? file.originalFilename.substring(file.originalFilename.lastIndexOf(".")).toLowerCase()
    : "";
  const isImage = file.mimeType.toLowerCase().startsWith("image/") || IMAGE_FILE_EXTENSIONS.has(extension);

  return {
    category: isImage ? "photo" : "other",
    intakeSection: "attachments",
    intakeRequirementKey: isImage ? "site_photos" : "scope_docs",
    intakeSource: "scoping_intake",
  };
}

async function attachLeadFilesToConvertedDeal(tenantDb: TenantDb, leadId: string, dealId: string) {
  const leadFiles = await tenantDb
    .select({
      id: files.id,
      category: files.category,
      originalFilename: files.originalFilename,
      mimeType: files.mimeType,
      tags: files.tags,
    })
    .from(files)
    .where(and(eq(files.leadId, leadId), eq(files.isActive, true)));

  for (const file of leadFiles) {
    const metadata = resolveLeadAttachmentConversionMetadata(file);
    const updates: Partial<typeof files.$inferInsert> = {
      dealId,
      category: metadata.category as FileCategory,
      updatedAt: new Date(),
    };
    if (metadata.intakeSection && metadata.intakeRequirementKey && metadata.intakeSource) {
      updates.intakeSection = metadata.intakeSection;
      updates.intakeRequirementKey = metadata.intakeRequirementKey;
      updates.intakeSource = metadata.intakeSource;
    }
    await tenantDb
      .update(files)
      .set(updates)
      .where(eq(files.id, file.id));
  }
}

export interface ConvertLeadInput {
  leadId: string;
  dealStageId?: string;
  userId: string;
  userRole: string;
  workflowRoute?: WorkflowRoute;
  assignedRepId?: string;
  primaryContactId?: string | null;
  officeId?: string;
  name?: string;
  source?: string;
  description?: string;
  ddEstimate?: string;
  bidEstimate?: string;
  awardedAmount?: string;
  projectTypeId?: string | null;
  regionId?: string;
  expectedCloseDate?: string;
  auditContext?: AuditContext;
}

interface LeadConversionDependencies {
  createDeal: typeof createDeal;
  getStageById: typeof getStageById;
  getStageBySlug: typeof getStageBySlug;
  now: () => Date;
}

const defaultDependencies: LeadConversionDependencies = {
  createDeal,
  getStageById,
  getStageBySlug,
  now: () => new Date(),
};

function workflowFamilyForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

function resolveWorkflowRoute(lead: typeof leads.$inferSelect): WorkflowRoute {
  if (lead.projectType?.trim().toLowerCase() === "service") {
    return "service";
  }

  const preQualValue =
    typeof lead.preQualValue === "number"
      ? lead.preQualValue
      : typeof lead.preQualValue === "string"
        ? Number(lead.preQualValue)
        : Number.NaN;

  if (Number.isFinite(preQualValue)) {
    return preQualValue < 50000 ? "service" : "normal";
  }

  return lead.pipelineType === "service" ? "service" : "normal";
}

export function createLeadConversionService(
  dependencies: Partial<LeadConversionDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };

  async function assertConversionQuestionnaireGate(
    tenantDb: TenantDb,
    lead: typeof leads.$inferSelect,
    currentLeadStage: NonNullable<Awaited<ReturnType<typeof getStageById>>>,
    opportunityStage: NonNullable<Awaited<ReturnType<typeof getStageBySlug>>>
  ) {
    const existingCustomerStatus = await computeExistingCustomerStatus(tenantDb, lead.companyId, new Date(), {
      excludeLeadId: lead.id,
    });
    const qualificationFields = ["estimated_value", "timeline_status"].filter(
      (fieldId) =>
        !isAnsweredQuestionValue(
          (lead.qualificationPayload as Record<string, string | boolean | number | null> | null)?.[fieldId]
        )
    );
    if (!isAnsweredQuestionValue(existingCustomerStatus.status)) {
      qualificationFields.unshift("existing_customer_status");
    }
    const questionAnswers = await applyLeadAttachmentAnswers(
      tenantDb,
      lead.id,
      await listLeadQuestionAnswers(tenantDb, lead.id)
    );
    const nodes = await listQuestionnaireNodes(tenantDb);
    const projectTypeQuestionIds = listMissingRequiredQuestionKeys(nodes, questionAnswers);

    if (qualificationFields.length === 0 && projectTypeQuestionIds.length === 0) {
      return;
    }

    throw new LeadStageTransitionError({
      allowed: false,
      code: "LEAD_STAGE_REQUIREMENTS_UNMET",
      message:
        "Complete the Sales Validation qualification fields and required project questions before converting this lead.",
      currentStage: {
        id: currentLeadStage.id,
        slug: currentLeadStage.slug ?? "sales_validation_stage",
        name: currentLeadStage.name ?? "Sales Validation Stage",
        isTerminal: currentLeadStage.isTerminal,
        displayOrder: currentLeadStage.displayOrder ?? 0,
      },
      targetStage: {
        id: opportunityStage.id,
        slug: opportunityStage.slug ?? "opportunity",
        name: opportunityStage.name ?? "Opportunity",
        isTerminal: opportunityStage.isTerminal,
        displayOrder: opportunityStage.displayOrder ?? 0,
      },
      missingRequirements: {
        prerequisiteFields: [],
        qualificationFields,
        projectTypeQuestionIds,
      },
    });
  }

  async function convertLead(tenantDb: TenantDb, input: ConvertLeadInput) {
    const leadRowResult = await tenantDb
      .select()
      .from(leads)
      .where(eq(leads.id, input.leadId))
      .for("update")
      .limit(1);

    const lead = leadRowResult[0] ?? null;
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }

    if (input.userRole === "rep" && lead.assignedRepId !== input.userId) {
      throw new AppError(403, "You can only convert your own leads");
    }

    if (lead.status === "converted") {
      throw new AppError(409, "Lead has already been converted");
    }

    if (lead.status === "disqualified") {
      throw new AppError(400, "Disqualified leads cannot be converted");
    }

    if (!lead.isActive) {
      throw new AppError(400, "Inactive leads cannot be converted");
    }

    const [existingDeal] = await tenantDb
      .select()
      .from(deals)
      .where(eq(deals.sourceLeadId, input.leadId))
      .limit(1);

    if (existingDeal) {
      throw new AppError(409, "Lead has already been converted");
    }

    const successorAssignedRepId = input.assignedRepId ?? lead.salesRepId ?? lead.assignedRepId;
    if (input.userRole === "rep" && successorAssignedRepId !== lead.assignedRepId) {
      throw new AppError(403, "You cannot reassign the successor deal");
    }

    const workflowRoute = resolveWorkflowRoute(lead);
    if (input.workflowRoute && input.workflowRoute !== workflowRoute) {
      throw new AppError(
        409,
        "workflowRoute does not match the lead's derived downstream route",
        "LEAD_CONVERSION_ROUTE_MISMATCH"
      );
    }

    const currentLeadStage = await deps.getStageById(lead.stageId, "lead");
    if (!currentLeadStage?.slug) {
      throw new AppError(500, "Current lead stage config is incomplete");
    }

    const currentCanonicalStageSlug = toCanonicalLeadStageSlug(currentLeadStage.slug);
    if (!currentCanonicalStageSlug) {
      throw new AppError(
        409,
        "Lead cannot be converted from a non-canonical stage",
        "LEAD_CONVERSION_STAGE_INVALID"
      );
    }

    if (currentCanonicalStageSlug !== "sales_validation" && currentCanonicalStageSlug !== "opportunity") {
      throw new AppError(
        409,
        "Only Sales Validation leads can be converted to deals. Move the lead through the canonical progression first.",
        "LEAD_CONVERSION_REQUIRES_SALES_VALIDATION"
      );
    }

    const workflowOpportunityStage = await deps.getStageBySlug(
      "opportunity",
      workflowFamilyForRoute(workflowRoute)
    );
    const opportunityStage =
      workflowOpportunityStage ??
      (workflowRoute === "service" ? await deps.getStageBySlug("opportunity", "standard_deal") : null);
    const resolvedDealStageId = input.dealStageId ?? opportunityStage?.id;

    if (!resolvedDealStageId || !opportunityStage) {
      throw new AppError(500, "Canonical opportunity stage config is incomplete");
    }

    if (isLeadEditV2Enabled()) {
      await assertConversionQuestionnaireGate(tenantDb, lead, currentLeadStage, opportunityStage);
    }

    const deal = await deps.createDeal(tenantDb, {
      name: input.name ?? lead.name,
      stageId: resolvedDealStageId,
      workflowRoute,
      assignedRepId: successorAssignedRepId,
      actorUserId: input.userId,
      officeId: input.officeId,
      primaryContactId:
        input.primaryContactId === undefined
          ? (lead.primaryContactId ?? undefined)
          : (input.primaryContactId ?? undefined),
      companyId: lead.companyId,
      propertyId: lead.propertyId,
      sourceLeadId: lead.id,
      creationContext: "lead_conversion",
      sourceLeadWriteMode: "lead_conversion",
      source: input.source ?? resolveLeadSourceDisplayValue(lead) ?? undefined,
      description: input.description ?? lead.description ?? undefined,
      // Carry the rep's gated lead estimate onto the Opportunity as a pipeline
      // estimate when conversion input does not supply one, so the value the rep
      // entered survives conversion (and shows on the dashboard). Pipeline estimate
      // only -- awardedAmount stays untouched to protect Won reporting.
      ddEstimate:
        input.ddEstimate ??
        normalizeLeadEstimatedValue(
          (lead.qualificationPayload as Record<string, unknown> | null | undefined)?.estimated_value
        ),
      bidEstimate: input.bidEstimate,
      awardedAmount: input.awardedAmount,
      // leads.bid_due_date is the authoritative source; the questionnaire answer is only a mirror.
      bidDueDate: lead.bidDueDate ?? null,
      officeCode: lead.officeCode ?? "dfw",
      projectType: lead.projectType ?? undefined,
      projectTypeId: input.projectTypeId ?? lead.projectTypeId ?? undefined,
      regionId: input.regionId,
      expectedCloseDate: input.expectedCloseDate,
      auditContext: input.auditContext,
    });

    await attachLeadFilesToConvertedDeal(tenantDb, lead.id, deal.id);

    const convertedAt = deps.now();

    const [updatedLead] = await tenantDb
      .update(leads)
      .set({
        stageId: lead.stageId,
        status: "converted",
        stageEnteredAt: convertedAt,
        convertedAt,
        isActive: false,
        updatedAt: convertedAt,
      })
      .where(eq(leads.id, input.leadId))
      .returning();

    if (input.auditContext) {
      const [company] = await tenantDb
        .select()
        .from(companies)
        .where(eq(companies.id, lead.companyId))
        .limit(1);

      await logActivity({
        tenantDb,
        actor: input.auditContext.actor,
        action: "update",
        entity: {
          tableName: "leads",
          entityType: "lead",
          recordId: input.leadId,
          nameSnapshot: company?.name ? `${lead.name} for ${company.name}` : lead.name,
          secondaryIdSnapshot: null,
        },
        fieldChanges: {
          status: { from: lead.status, to: "converted" },
          isActive: { from: lead.isActive, to: false },
        },
        metadata: {
          convertedToDealId: deal.id,
          convertedToDealNumber: deal.dealNumber ?? null,
        },
        ipAddress: input.auditContext.ipAddress ?? null,
        userAgent: input.auditContext.userAgent ?? null,
      });
    }

    return {
      lead: updatedLead ?? {
        ...lead,
        status: "converted",
        convertedAt,
        isActive: false,
        updatedAt: convertedAt,
      },
      deal,
    };
  }

  return {
    convertLead,
  };
}

const liveService = createLeadConversionService();

export const convertLead = liveService.convertLead;
