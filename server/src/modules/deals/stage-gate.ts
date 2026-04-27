import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  pipelineStageConfig,
  deals,
  dealApprovals,
  files,
  closeoutChecklistItems,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { toCanonicalDealStageSlug } from "@trock-crm/shared/types";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import type { UserRole } from "@trock-crm/shared/types";
import { evaluateDealScopingReadiness } from "./scoping-service.js";
import { getResolvedDeal, type ResolvedDealView } from "./lineage-resolver.js";

type TenantDb = NodePgDatabase<typeof schema>;

type StageGateChecklistSource = "stage" | "scoping" | "combined";

export interface StageGateChecklistItem {
  key: string;
  label: string;
  satisfied: boolean;
  source: StageGateChecklistSource;
}

export interface StageGateResult {
  allowed: boolean;
  isBackwardMove: boolean;
  isTerminal: boolean;
  targetStage: {
    id: string;
    name: string;
    slug: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  currentStage: {
    id: string;
    name: string;
    slug: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  missingRequirements: {
    fields: string[];
    documents: string[];
    approvals: string[];
    effectiveChecklist?: {
      fields: StageGateChecklistItem[];
      attachments: StageGateChecklistItem[];
      approvals: StageGateChecklistItem[];
    };
  };
  effectiveChecklist: {
    fields: StageGateChecklistItem[];
    attachments: StageGateChecklistItem[];
    approvals: StageGateChecklistItem[];
  };
  requiresOverride: boolean;
  overrideType: "backward_move" | "missing_requirements" | null;
  blockReason: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  ddEstimate: "DD Estimate",
  bidEstimate: "Bid Estimate",
  awardedAmount: "Awarded Amount",
  expectedCloseDate: "Expected Close Date",
  propertyAddress: "Property Address",
  projectTypeId: "Project Type",
  regionId: "Region",
  primaryContactId: "Primary Contact",
  companyId: "Company",
  description: "Description",
};

const DOCUMENT_LABELS: Record<string, string> = {
  photo: "Photo",
  contract: "Contract",
  rfp: "RFP",
  estimate: "Estimate",
  change_order: "Change Order",
  proposal: "Proposal",
  permit: "Permit",
  inspection: "Inspection",
  correspondence: "Correspondence",
  insurance: "Insurance",
  warranty: "Warranty",
  closeout: "Closeout",
  other: "Other",
};

function formatStartCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatFieldLabel(field: string) {
  if (field.includes(".")) {
    const [sectionName, fieldName] = field.split(".");
    return `${formatStartCase(sectionName ?? field)}: ${formatStartCase(fieldName ?? "")}`.trim();
  }

  return FIELD_LABELS[field] ?? formatStartCase(field);
}

function formatDocumentLabel(document: string) {
  return DOCUMENT_LABELS[document] ?? formatStartCase(document);
}

function pushChecklistItem(
  items: StageGateChecklistItem[],
  nextItem: StageGateChecklistItem
) {
  const existingItem = items.find((item) => item.key === nextItem.key);
  if (!existingItem) {
    items.push(nextItem);
    return;
  }

  existingItem.satisfied = existingItem.satisfied && nextItem.satisfied;
  if (existingItem.source !== nextItem.source) {
    existingItem.source = "combined";
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getRequiredFieldValue(
  deal: typeof deals.$inferSelect,
  resolvedDeal: ResolvedDealView,
  field: string
) {
  if (Object.prototype.hasOwnProperty.call(resolvedDeal.resolved, field)) {
    return resolvedDeal.resolved[field as keyof ResolvedDealView["resolved"]];
  }

  return (deal as Record<string, unknown>)[field];
}

function isVerifiedLinkedStageDocument(file: {
  category: unknown;
  intakeRequirementKey: unknown;
  intakeSource: unknown;
  r2Key: unknown;
  r2Bucket: unknown;
}) {
  return (
    hasNonEmptyText(file.category) &&
    hasNonEmptyText(file.intakeRequirementKey) &&
    file.intakeSource === "scoping_intake" &&
    hasNonEmptyText(file.r2Key) &&
    hasNonEmptyText(file.r2Bucket)
  );
}

function workflowFamilyForRoute(workflowRoute: "normal" | "service") {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

function isEstimatingBoundaryStageSlug(stageSlug: string, workflowRoute: "normal" | "service") {
  return (
    stageSlug === "estimating" ||
    stageSlug === (workflowRoute === "service" ? "service_estimating" : "estimate_in_progress")
  );
}

/**
 * Validate whether a deal can move to the target stage.
 *
 * Returns a full picture of what's required, what's missing, and whether
 * the move is allowed for the given user role. Does NOT mutate any data.
 */
export async function validateStageGate(
  tenantDb: TenantDb,
  dealId: string,
  targetStageId: string,
  userRole: UserRole,
  userId: string
): Promise<StageGateResult> {
  const resolvedDeal = await getResolvedDeal(tenantDb, dealId);
  const deal = resolvedDeal.deal;
  const resolved = resolvedDeal.resolved;

  // Reps can only modify their own deals
  if (userRole === "rep" && resolved.assignedRepId !== userId) {
    throw new AppError(403, "You can only modify your own deals");
  }

  // Fetch current stage and target stage from public config
  const [currentStageResult, targetStageResult] = await Promise.all([
    db.select().from(pipelineStageConfig).where(eq(pipelineStageConfig.id, deal.stageId)).limit(1),
    db.select().from(pipelineStageConfig).where(eq(pipelineStageConfig.id, targetStageId)).limit(1),
  ]);

  if (currentStageResult.length === 0) {
    throw new AppError(404, "Current stage config not found");
  }
  if (targetStageResult.length === 0) {
    throw new AppError(404, "Pipeline stage not found");
  }

  const currentStage = currentStageResult[0];
  const targetStage = targetStageResult[0];

  const requiredWorkflowFamily = workflowFamilyForRoute(resolved.workflowRoute);
  const targetWorkflowFamily = (targetStage as { workflowFamily?: string | null }).workflowFamily ?? null;
  if (targetWorkflowFamily === "lead" || (targetWorkflowFamily && targetWorkflowFamily !== requiredWorkflowFamily)) {
    throw new AppError(
      400,
      "Target stage is not valid for the deal workflow route.",
      "INVALID_STAGE_FOR_WORKFLOW_ROUTE"
    );
  }

  // Same stage -- no-op
  if (currentStage.id === targetStage.id) {
    return {
      allowed: true,
      isBackwardMove: false,
      isTerminal: targetStage.isTerminal,
      targetStage: {
        id: targetStage.id,
        name: targetStage.name,
        slug: targetStage.slug,
        isTerminal: targetStage.isTerminal,
        displayOrder: targetStage.displayOrder,
      },
      currentStage: {
        id: currentStage.id,
        name: currentStage.name,
        slug: currentStage.slug,
        isTerminal: currentStage.isTerminal,
        displayOrder: currentStage.displayOrder,
      },
      missingRequirements: {
        fields: [],
        documents: [],
        approvals: [],
        effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      },
      effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      requiresOverride: false,
      overrideType: null,
      blockReason: null,
    };
  }

  // Detect backward move
  const isBackwardMove = targetStage.displayOrder < currentStage.displayOrder;

  // Check required fields on the deal
  const requiredFields = (targetStage.requiredFields as string[]) ?? [];
  const missingFields: string[] = [];
  for (const field of requiredFields) {
    const value = getRequiredFieldValue(deal, resolvedDeal, field);
    if (value == null || value === "") {
      missingFields.push(field);
    }
  }

  // Check required documents (file categories that must exist for this deal)
  const requiredDocuments = (targetStage.requiredDocuments as string[]) ?? [];
  const missingDocuments: string[] = [];
  const linkedVerifiedCategories = new Set<string>();
  if (requiredDocuments.length > 0) {
    const existingFiles = await tenantDb
      .select({
        category: files.category,
        intakeRequirementKey: files.intakeRequirementKey,
        intakeSource: files.intakeSource,
        r2Key: files.r2Key,
        r2Bucket: files.r2Bucket,
      })
      .from(files)
      .where(and(eq(files.dealId, dealId), eq(files.isActive, true)));

    for (const file of existingFiles) {
      if (isVerifiedLinkedStageDocument(file)) {
        linkedVerifiedCategories.add(file.category);
      }
    }

    for (const docType of requiredDocuments) {
      if (!linkedVerifiedCategories.has(docType)) {
        missingDocuments.push(docType);
      }
    }
  }

  // Check required approvals
  const requiredApprovals = (targetStage.requiredApprovals as string[]) ?? [];
  const missingApprovals: string[] = [];
  if (requiredApprovals.length > 0) {
    const existingApprovals = await tenantDb
      .select()
      .from(dealApprovals)
      .where(
        and(
          eq(dealApprovals.dealId, dealId),
          eq(dealApprovals.targetStageId, targetStageId),
          eq(dealApprovals.status, "approved")
        )
      );

    const approvedRoles = new Set(existingApprovals.map((a) => a.requiredRole));
    for (const role of requiredApprovals) {
      if (!approvedRoles.has(role as any)) {
        missingApprovals.push(role);
      }
    }
  }

  const effectiveChecklist = {
    fields: requiredFields.map((field) => ({
      key: field,
      label: formatFieldLabel(field),
      satisfied: !missingFields.includes(field),
      source: "stage" as const,
    })),
    attachments: requiredDocuments.map((document) => ({
      key: document,
      label: formatDocumentLabel(document),
      satisfied: linkedVerifiedCategories.has(document),
      source: "stage" as const,
    })),
    approvals: requiredApprovals.map((role) => ({
      key: role,
      label: `${formatStartCase(role)} Approval`,
      satisfied: !missingApprovals.includes(role),
      source: "stage" as const,
    })),
  };

  const hasMissingRequirements =
    missingFields.length > 0 || missingDocuments.length > 0 || missingApprovals.length > 0;

  const isDirectorOrAdmin = userRole === "director" || userRole === "admin";

  // Determine if the move is allowed
  let allowed = true;
  let blockReason: string | null = null;
  let requiresOverride = false;
  let overrideType: "backward_move" | "missing_requirements" | null = null;

  // Rule 1: Backward move -- blocked for reps, director can override
  if (isBackwardMove) {
    if (!isDirectorOrAdmin) {
      allowed = false;
      blockReason = "Reps cannot move deals backward. A director must perform this action.";
    } else {
      requiresOverride = true;
      overrideType = "backward_move";
    }
  }

  const canonicalTargetStageSlug = toCanonicalDealStageSlug(
    targetStage.slug,
    resolved.workflowRoute ?? "normal"
  );

  // Rule 2: Close-out checklist must be complete before moving from Close-Out into a won outcome.
  if (
    currentStage.slug === "close_out" &&
    (canonicalTargetStageSlug === "sent_to_production" ||
      canonicalTargetStageSlug === "service_sent_to_production")
  ) {
    const checklistItems = await tenantDb
      .select()
      .from(closeoutChecklistItems)
      .where(eq(closeoutChecklistItems.dealId, dealId));

    if (checklistItems.length === 0) {
      // Checklist was never initialized — block until user visits Close-Out tab
      if (!isDirectorOrAdmin) {
        allowed = false;
        blockReason = "Close-out checklist has not been initialized. Visit the Close-Out tab to begin.";
      } else {
        requiresOverride = true;
        overrideType = overrideType ?? "missing_requirements";
      }
    } else {
      const incomplete = checklistItems.filter((item) => !item.isCompleted);
      if (incomplete.length > 0) {
        const labels = incomplete.map((i) => i.label).join(", ");
        if (!isDirectorOrAdmin) {
          allowed = false;
          blockReason = `Close-out checklist incomplete: ${labels}`;
        } else {
          requiresOverride = true;
          overrideType = overrideType ?? "missing_requirements";
        }
      }
    }
  }

  // Rule 3: Missing requirements -- blocked for reps, director can override
  if (hasMissingRequirements) {
    if (!isDirectorOrAdmin) {
      allowed = false;
      blockReason = blockReason
        ? `${blockReason} Additionally, stage requirements are not met.`
        : "Stage requirements are not met. Complete all required items before advancing.";
    } else {
      requiresOverride = true;
      overrideType = overrideType ?? "missing_requirements";
    }
  }

  if (isEstimatingBoundaryStageSlug(targetStage.slug, resolved.workflowRoute)) {
    const scopingReadiness = await evaluateDealScopingReadiness(tenantDb, dealId);
    const scopingMissingFields = Object.entries(scopingReadiness.errors.sections).flatMap(
      ([sectionName, fieldNames]) => fieldNames.map((fieldName) => `${sectionName}.${fieldName}`)
    );
    const scopingAttachmentRequirements = scopingReadiness.attachmentRequirements ?? [];
    const scopingMissingDocuments = scopingAttachmentRequirements
      .filter((attachment) => !attachment.satisfied)
      .map((attachment) => attachment.category);

    for (const field of scopingMissingFields) {
      pushChecklistItem(effectiveChecklist.fields, {
        key: field,
        label: formatFieldLabel(field),
        satisfied: false,
        source: "scoping",
      });
    }

    for (const attachment of scopingAttachmentRequirements) {
      pushChecklistItem(effectiveChecklist.attachments, {
        key: attachment.category,
        label: attachment.label,
        satisfied: attachment.satisfied,
        source: "scoping",
      });
    }

    if (scopingReadiness.status === "draft") {
      allowed = false;
      requiresOverride = false;
      overrideType = null;
      blockReason = "Scoping intake is incomplete. Complete all required scoping items before advancing.";
      missingFields.push(...scopingMissingFields);
      missingDocuments.push(...scopingMissingDocuments);
    }
  }

  return {
    allowed,
    isBackwardMove,
    isTerminal: targetStage.isTerminal,
    targetStage: {
      id: targetStage.id,
      name: targetStage.name,
      slug: targetStage.slug,
      isTerminal: targetStage.isTerminal,
      displayOrder: targetStage.displayOrder,
    },
    currentStage: {
      id: currentStage.id,
      name: currentStage.name,
      slug: currentStage.slug,
      isTerminal: currentStage.isTerminal,
      displayOrder: currentStage.displayOrder,
    },
    missingRequirements: {
      fields: uniqueStrings(missingFields),
      documents: uniqueStrings(missingDocuments),
      approvals: uniqueStrings(missingApprovals),
      effectiveChecklist,
    },
    effectiveChecklist,
    requiresOverride,
    overrideType,
    blockReason,
  };
}

/**
 * Check a stage gate without committing -- used by the frontend to show
 * the requirements checklist before the user confirms.
 */
export async function preflightStageCheck(
  tenantDb: TenantDb,
  dealId: string,
  targetStageId: string,
  userRole: UserRole,
  userId: string
): Promise<StageGateResult> {
  return validateStageGate(tenantDb, dealId, targetStageId, userRole, userId);
}
