import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { aiTaskSuggestions } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { createTask } from "../tasks/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export async function acceptTaskSuggestion(
  tenantDb: TenantDb,
  suggestionId: string,
  userId: string
) {
  const [suggestion] = await tenantDb
    .select()
    .from(aiTaskSuggestions)
    .where(eq(aiTaskSuggestions.id, suggestionId))
    .limit(1);

  if (!suggestion) {
    throw new AppError(404, "Task suggestion not found");
  }

  if (suggestion.status !== "suggested") {
    throw new AppError(400, `Task suggestion is already ${suggestion.status}`);
  }

  const reservedAt = new Date();
  const [reserved] = await tenantDb
    .update(aiTaskSuggestions)
    .set({
      status: "accepted",
      resolvedAt: reservedAt,
    })
    .where(and(eq(aiTaskSuggestions.id, suggestionId), eq(aiTaskSuggestions.status, "suggested")))
    .returning();

  if (!reserved) {
    throw new AppError(409, "Task suggestion is already being processed");
  }

  const task = await createTask(tenantDb, {
    title: reserved.title,
    description: reserved.description ?? undefined,
    type: "follow_up",
    priority: reserved.priority,
    assignedTo: reserved.suggestedOwnerId ?? userId,
    createdBy: userId,
    dealId: reserved.scopeType === "deal" ? reserved.scopeId : undefined,
  });

  const [updated] = await tenantDb
    .update(aiTaskSuggestions)
    .set({
      acceptedTaskId: task.id,
    })
    .where(eq(aiTaskSuggestions.id, suggestionId))
    .returning();

  return {
    suggestionId,
    acceptedTaskId: updated?.acceptedTaskId ?? task.id,
    status: updated?.status ?? "accepted",
  };
}
