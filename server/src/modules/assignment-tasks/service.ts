import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { tasks } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

const ACTIVE_TASK_STATUSES = [
  "pending",
  "scheduled",
  "in_progress",
  "waiting_on",
  "blocked",
] as const;

export interface CreateAssignmentTaskInput {
  entityType: "lead" | "deal";
  entityId: string;
  entityName: string;
  previousAssignedRepId: string | null;
  nextAssignedRepId: string | null;
  actorUserId: string;
  officeId?: string | null;
  now?: Date;
}

export async function createAssignmentTaskIfNeeded(
  tenantDb: TenantDb,
  input: CreateAssignmentTaskInput
) {
  if (
    input.nextAssignedRepId == null ||
    input.previousAssignedRepId === input.nextAssignedRepId
  ) {
    return null;
  }

  const title =
    input.entityType === "lead" ? "New Lead Assignment" : "New Deal Assignment";

  const existing = await tenantDb
    .select()
    .from(tasks)
    .where(
      input.entityType === "deal"
        ? and(
            eq(tasks.title, title),
            eq(tasks.assignedTo, input.nextAssignedRepId),
            eq(tasks.dealId, input.entityId),
            inArray(tasks.status, ACTIVE_TASK_STATUSES as any)
          )
        : and(
            eq(tasks.title, title),
            eq(tasks.assignedTo, input.nextAssignedRepId),
            sql`${tasks.entitySnapshot} ->> 'leadId' = ${input.entityId}`,
            inArray(tasks.status, ACTIVE_TASK_STATUSES as any)
          )
    )
    .limit(1);

  if (existing[0]) {
    return null;
  }

  const now = input.now ?? new Date();
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + 3);

  const [task] = await tenantDb
    .insert(tasks)
    .values({
      title,
      description: `${input.entityName} was assigned to you by ${input.actorUserId} on ${now.toISOString().slice(0, 10)}.`,
      type: "manual",
      priority: "normal",
      status: "pending",
      assignedTo: input.nextAssignedRepId,
      createdBy: input.actorUserId,
      officeId: input.officeId ?? null,
      dealId: input.entityType === "deal" ? input.entityId : null,
      entitySnapshot: {
        entityType: input.entityType,
        entityId: input.entityId,
        leadId: input.entityType === "lead" ? input.entityId : null,
        dealId: input.entityType === "deal" ? input.entityId : null,
        assignedRepId: input.nextAssignedRepId,
        previousAssignedRepId: input.previousAssignedRepId,
        actorUserId: input.actorUserId,
        assignedAt: now.toISOString(),
      },
      dueDate: dueDate.toISOString().slice(0, 10),
    } as typeof tasks.$inferInsert)
    .returning();

  return task ?? null;
}
