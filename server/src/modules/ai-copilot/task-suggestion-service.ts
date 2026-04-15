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

  const task = await createTask(tenantDb, {
    title: suggestion.title,
    description: suggestion.description ?? undefined,
    type: "follow_up",
    priority: suggestion.priority,
    assignedTo: suggestion.suggestedOwnerId ?? userId,
    createdBy: userId,
    dealId: suggestion.scopeType === "deal" ? suggestion.scopeId : undefined,
  });

  const [updated] = await tenantDb
    .update(aiTaskSuggestions)
    .set({
      status: "accepted",
      acceptedTaskId: task.id,
      resolvedAt: new Date(),
    })
    .where(and(eq(aiTaskSuggestions.id, suggestionId), eq(aiTaskSuggestions.status, "suggested")))
    .returning();

  return {
    suggestionId,
    acceptedTaskId: updated?.acceptedTaskId ?? task.id,
    status: updated?.status ?? "accepted",
  };
}
