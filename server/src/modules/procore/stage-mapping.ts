// server/src/modules/procore/stage-mapping.ts
// Builds a reverse mapping from Procore stage names to CRM pipeline stage IDs.
// Used by the worker's syncProjectStatusToCrm() to apply Procore project
// stage/status changes back to CRM deals.

import { isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { pipelineStageConfig } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowFamily } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ReverseMappedStage {
  stageId: string;
  stageName: string;
  displayOrder: number;
  workflowFamily: WorkflowFamily;
  ambiguous: boolean;
}

/**
 * Build a reverse mapping from Procore stage names to CRM stage IDs.
 * If multiple CRM stages map to the same Procore stage, flag as ambiguous.
 *
 * @param tenantDb - Drizzle database instance (public schema access)
 * @returns Map keyed by lowercase Procore stage name
 */
export async function buildReverseStageMap(
  tenantDb: TenantDb,
  workflowFamily: WorkflowFamily
): Promise<Map<string, ReverseMappedStage>> {
  if (!workflowFamily) {
    throw new Error("workflowFamily is required");
  }

  const stages = await tenantDb
    .select({
      id: pipelineStageConfig.id,
      name: pipelineStageConfig.name,
      displayOrder: pipelineStageConfig.displayOrder,
      workflowFamily: pipelineStageConfig.workflowFamily,
      procoreStageMapping: pipelineStageConfig.procoreStageMapping,
    })
    .from(pipelineStageConfig)
    .where(isNotNull(pipelineStageConfig.procoreStageMapping));

  const map = new Map<string, ReverseMappedStage>();

  for (const stage of stages) {
    if (stage.workflowFamily !== workflowFamily) {
      continue;
    }

    const procoreStage = stage.procoreStageMapping!.toLowerCase().trim();
    if (!procoreStage) continue;

    const existing = map.get(procoreStage);
    if (existing) {
      // Multiple CRM stages map to same Procore stage — mark both as ambiguous
      existing.ambiguous = true;
      // Keep the first one found but flag it
      console.warn(
        `[Procore:stage-mapping] Ambiguous: Procore stage "${procoreStage}" maps to ` +
          `both "${existing.stageName}" (${existing.stageId}) and "${stage.name}" (${stage.id})`
      );
    } else {
      map.set(procoreStage, {
        stageId: stage.id,
        stageName: stage.name,
        displayOrder: stage.displayOrder,
        workflowFamily: stage.workflowFamily,
        ambiguous: false,
      });
    }
  }

  return map;
}
