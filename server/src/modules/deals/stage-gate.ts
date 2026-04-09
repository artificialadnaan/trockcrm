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
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import type { UserRole } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

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
  };
  requiresOverride: boolean;
  overrideType: "backward_move" | "missing_requirements" | null;
  blockReason: string | null;
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
  // Fetch current deal
  const dealResult = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (dealResult.length === 0) {
    throw new AppError(404, "Deal not found");
  }
  const deal = dealResult[0];

  // Reps can only modify their own deals
  if (userRole === "rep" && deal.assignedRepId !== userId) {
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
      missingRequirements: { fields: [], documents: [], approvals: [] },
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
    const value = (deal as any)[field];
    if (value == null || value === "") {
      missingFields.push(field);
    }
  }

  // Check required documents (file categories that must exist for this deal)
  const requiredDocuments = (targetStage.requiredDocuments as string[]) ?? [];
  const missingDocuments: string[] = [];
  if (requiredDocuments.length > 0) {
    // Query files for this deal by category
    const existingFiles = await tenantDb
      .select({ category: files.category })
      .from(files)
      .where(and(eq(files.dealId, dealId), eq(files.isActive, true)));

    const existingCategories = new Set(existingFiles.map((f) => f.category));
    for (const docType of requiredDocuments) {
      if (!existingCategories.has(docType as any)) {
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

  // Rule 2: Close-out checklist must be complete before moving to closed_won
  if (targetStage.slug === "closed_won" && currentStage.slug === "close_out") {
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
      fields: missingFields,
      documents: missingDocuments,
      approvals: missingApprovals,
    },
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
