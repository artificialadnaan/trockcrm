import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { punchListItems } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreatePunchListItemInput {
  dealId: string;
  type: string;
  title: string;
  description?: string;
  assignedTo?: string;
  location?: string;
  priority?: string;
  createdBy: string;
}

export interface UpdatePunchListItemInput {
  type?: string;
  title?: string;
  description?: string | null;
  assignedTo?: string | null;
  location?: string | null;
  priority?: string;
  status?: string;
}

export async function getPunchList(tenantDb: TenantDb, dealId: string) {
  const items = await tenantDb
    .select()
    .from(punchListItems)
    .where(eq(punchListItems.dealId, dealId))
    .orderBy(punchListItems.createdAt);

  const internal = items.filter((i) => i.type === "internal");
  const external = items.filter((i) => i.type === "external");

  const summary = {
    internal: {
      total: internal.length,
      completed: internal.filter((i) => i.status === "completed").length,
    },
    external: {
      total: external.length,
      completed: external.filter((i) => i.status === "completed").length,
    },
  };

  return { items, summary };
}

export async function createPunchListItem(
  tenantDb: TenantDb,
  input: CreatePunchListItemInput
) {
  if (!input.title || input.title.trim().length === 0) {
    throw new AppError(400, "Title is required");
  }
  if (!input.type || !["internal", "external"].includes(input.type)) {
    throw new AppError(400, "type must be 'internal' or 'external'");
  }
  if (!input.createdBy) throw new AppError(400, "createdBy is required");

  const result = await tenantDb
    .insert(punchListItems)
    .values({
      dealId: input.dealId,
      type: input.type as any,
      title: input.title.trim(),
      description: input.description ?? null,
      assignedTo: input.assignedTo ?? null,
      location: input.location ?? null,
      priority: (input.priority as any) ?? "normal",
      createdBy: input.createdBy,
    })
    .returning();

  return result[0];
}

export async function updatePunchListItem(
  tenantDb: TenantDb,
  itemId: string,
  dealId: string,
  input: UpdatePunchListItemInput
) {
  const [existing] = await tenantDb
    .select()
    .from(punchListItems)
    .where(and(eq(punchListItems.id, itemId), eq(punchListItems.dealId, dealId)))
    .limit(1);

  if (!existing) throw new AppError(404, "Punch list item not found");

  const updates: Record<string, any> = {};
  if (input.type !== undefined) updates.type = input.type;
  if (input.title !== undefined) updates.title = input.title.trim();
  if (input.description !== undefined) updates.description = input.description;
  if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;
  if (input.location !== undefined) updates.location = input.location;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.status !== undefined) updates.status = input.status;

  if (Object.keys(updates).length === 0) return existing;

  updates.updatedAt = new Date();

  const result = await tenantDb
    .update(punchListItems)
    .set(updates)
    .where(and(eq(punchListItems.id, itemId), eq(punchListItems.dealId, dealId)))
    .returning();

  return result[0];
}

export async function completePunchListItem(
  tenantDb: TenantDb,
  itemId: string,
  dealId: string,
  userId: string
) {
  const result = await tenantDb
    .update(punchListItems)
    .set({
      status: "completed",
      completedAt: new Date(),
      completedBy: userId,
      updatedAt: new Date(),
    })
    .where(and(eq(punchListItems.id, itemId), eq(punchListItems.dealId, dealId)))
    .returning();

  if (result.length === 0) throw new AppError(404, "Punch list item not found");
  return result[0];
}
