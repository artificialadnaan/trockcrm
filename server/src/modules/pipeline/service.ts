import { and, asc, eq } from "drizzle-orm";
import {
  pipelineStageConfig,
  lostDealReasons,
  projectTypeConfig,
  regionConfig,
} from "@trock-crm/shared/schema";
import type { WorkflowFamily } from "@trock-crm/shared/types";
import { db } from "../../db.js";

function buildStageWhere(
  idOrSlug: { id?: string; slug?: string },
  workflowFamily?: WorkflowFamily
) {
  const conditions = [];

  if (idOrSlug.id) {
    conditions.push(eq(pipelineStageConfig.id, idOrSlug.id));
  }

  if (idOrSlug.slug) {
    conditions.push(eq(pipelineStageConfig.slug, idOrSlug.slug));
  }

  if (workflowFamily) {
    conditions.push(eq(pipelineStageConfig.workflowFamily, workflowFamily));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function getAllStages(workflowFamily?: WorkflowFamily) {
  return db
    .select()
    .from(pipelineStageConfig)
    .where(buildStageWhere({}, workflowFamily))
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

export async function getStageById(id: string, workflowFamily?: WorkflowFamily) {
  const result = await db
    .select()
    .from(pipelineStageConfig)
    .where(buildStageWhere({ id }, workflowFamily))
    .limit(1);
  return result[0] ?? null;
}

export async function getStageBySlug(slug: string, workflowFamily?: WorkflowFamily) {
  const result = await db
    .select()
    .from(pipelineStageConfig)
    .where(buildStageWhere({ slug }, workflowFamily))
    .limit(1);
  return result[0] ?? null;
}

export async function getActiveLostReasons() {
  return db
    .select()
    .from(lostDealReasons)
    .where(eq(lostDealReasons.isActive, true))
    .orderBy(asc(lostDealReasons.displayOrder));
}

export async function getActiveProjectTypes() {
  return db
    .select()
    .from(projectTypeConfig)
    .where(eq(projectTypeConfig.isActive, true))
    .orderBy(asc(projectTypeConfig.displayOrder));
}

export async function getActiveRegions() {
  return db
    .select()
    .from(regionConfig)
    .where(eq(regionConfig.isActive, true))
    .orderBy(asc(regionConfig.displayOrder));
}
