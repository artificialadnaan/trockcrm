import { eq, asc } from "drizzle-orm";
import { pipelineStageConfig } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

export async function listPipelineStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

export async function updatePipelineStage(
  id: string,
  input: Partial<{
    name: string;
    color: string;
    staleThresholdDays: number | null;
    procoreStageMapping: string | null;
    requiredFields: string[];
    requiredDocuments: string[];
    requiredApprovals: string[];
    isActive: boolean;
  }>
) {
  const existing = await db
    .select({ id: pipelineStageConfig.id, isTerminal: pipelineStageConfig.isTerminal })
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.id, id))
    .limit(1);

  if (!existing[0]) throw new AppError(404, "Pipeline stage not found");

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.color !== undefined) updates.color = input.color;
  if (input.staleThresholdDays !== undefined) updates.staleThresholdDays = input.staleThresholdDays;
  if (input.procoreStageMapping !== undefined) updates.procoreStageMapping = input.procoreStageMapping;
  if (input.requiredFields !== undefined) updates.requiredFields = input.requiredFields;
  if (input.requiredDocuments !== undefined) updates.requiredDocuments = input.requiredDocuments;
  if (input.requiredApprovals !== undefined) updates.requiredApprovals = input.requiredApprovals;

  if (Object.keys(updates).length === 0) {
    return existing[0];
  }

  const [updated] = await db
    .update(pipelineStageConfig)
    .set(updates)
    .where(eq(pipelineStageConfig.id, id))
    .returning();

  return updated;
}

/** Reorder stages by providing ordered array of stage IDs. */
export async function reorderPipelineStages(orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db
      .update(pipelineStageConfig)
      .set({ displayOrder: i + 1 })
      .where(eq(pipelineStageConfig.id, orderedIds[i]));
  }
}
