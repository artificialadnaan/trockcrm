import { eq, asc } from "drizzle-orm";
import {
  pipelineStageConfig,
  lostDealReasons,
  projectTypeConfig,
  regionConfig,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";

export async function getAllStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

export async function getStageById(id: string) {
  const result = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.id, id))
    .limit(1);
  return result[0] ?? null;
}

export async function getStageBySlug(slug: string) {
  const result = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.slug, slug))
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
