import { eq, asc, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { estimateSections, estimateLineItems } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateLineItemInput {
  description: string;
  quantity?: string | number;
  unit?: string;
  unitPrice?: string | number;
  notes?: string;
  displayOrder?: number;
}

export interface UpdateLineItemInput {
  description?: string;
  quantity?: string | number;
  unit?: string | null;
  unitPrice?: string | number;
  notes?: string | null;
  displayOrder?: number;
}

function calcTotal(quantity: string | number, unitPrice: string | number): string {
  const q = Number(quantity ?? 1);
  const up = Number(unitPrice ?? 0);
  return (q * up).toFixed(2);
}

export async function getEstimate(tenantDb: TenantDb, dealId: string) {
  const sections = await tenantDb
    .select()
    .from(estimateSections)
    .where(eq(estimateSections.dealId, dealId))
    .orderBy(asc(estimateSections.displayOrder));

  const sectionIds = sections.map((s) => s.id);

  let allItems: (typeof estimateLineItems.$inferSelect)[] = [];
  if (sectionIds.length > 0) {
    // Fetch items for all sections in one query, filter client-side to avoid IN issues
    const allItemsRaw = await tenantDb
      .select()
      .from(estimateLineItems)
      .orderBy(asc(estimateLineItems.displayOrder));

    allItems = allItemsRaw.filter((item) => sectionIds.includes(item.sectionId));
  }

  const itemsBySectionId = new Map<string, typeof allItems>();
  for (const item of allItems) {
    const list = itemsBySectionId.get(item.sectionId) ?? [];
    list.push(item);
    itemsBySectionId.set(item.sectionId, list);
  }

  let grandTotal = 0;

  const sectionsWithItems = sections.map((section) => {
    const items = itemsBySectionId.get(section.id) ?? [];
    const subtotal = items.reduce((sum, item) => sum + Number(item.totalPrice ?? 0), 0);
    grandTotal += subtotal;
    return { ...section, items, subtotal: subtotal.toFixed(2) };
  });

  return { sections: sectionsWithItems, grandTotal: grandTotal.toFixed(2) };
}

export async function createSection(
  tenantDb: TenantDb,
  dealId: string,
  name: string,
  displayOrder?: number
) {
  if (!name || name.trim().length === 0) throw new AppError(400, "Section name is required");

  const result = await tenantDb
    .insert(estimateSections)
    .values({
      dealId,
      name: name.trim(),
      displayOrder: displayOrder ?? 0,
    })
    .returning();

  return result[0];
}

export async function updateSection(
  tenantDb: TenantDb,
  sectionId: string,
  dealId: string,
  input: { name?: string; displayOrder?: number }
) {
  const updates: Record<string, any> = {};
  if (input.name !== undefined) updates.name = input.name.trim();
  if (input.displayOrder !== undefined) updates.displayOrder = input.displayOrder;

  if (Object.keys(updates).length === 0) {
    const [existing] = await tenantDb
      .select()
      .from(estimateSections)
      .where(and(eq(estimateSections.id, sectionId), eq(estimateSections.dealId, dealId)))
      .limit(1);
    if (!existing) throw new AppError(404, "Section not found");
    return existing;
  }

  updates.updatedAt = new Date();

  const result = await tenantDb
    .update(estimateSections)
    .set(updates)
    .where(and(eq(estimateSections.id, sectionId), eq(estimateSections.dealId, dealId)))
    .returning();

  if (result.length === 0) throw new AppError(404, "Section not found");
  return result[0];
}

export async function deleteSection(tenantDb: TenantDb, sectionId: string, dealId: string) {
  const [section] = await tenantDb
    .select()
    .from(estimateSections)
    .where(and(eq(estimateSections.id, sectionId), eq(estimateSections.dealId, dealId)))
    .limit(1);

  if (!section) throw new AppError(404, "Section not found");

  // Cascade delete line items first
  await tenantDb
    .delete(estimateLineItems)
    .where(eq(estimateLineItems.sectionId, sectionId));

  await tenantDb
    .delete(estimateSections)
    .where(eq(estimateSections.id, sectionId));
}

export async function createLineItem(
  tenantDb: TenantDb,
  dealId: string,
  sectionId: string,
  input: CreateLineItemInput
) {
  if (!input.description || input.description.trim().length === 0) {
    throw new AppError(400, "Line item description is required");
  }

  const [section] = await tenantDb
    .select()
    .from(estimateSections)
    .where(and(eq(estimateSections.id, sectionId), eq(estimateSections.dealId, dealId)))
    .limit(1);

  if (!section) throw new AppError(404, "Section not found");

  const quantity = String(input.quantity ?? "1");
  const unitPrice = String(input.unitPrice ?? "0");
  const totalPrice = calcTotal(quantity, unitPrice);

  const result = await tenantDb
    .insert(estimateLineItems)
    .values({
      sectionId,
      description: input.description.trim(),
      quantity,
      unit: input.unit ?? null,
      unitPrice,
      totalPrice,
      notes: input.notes ?? null,
      displayOrder: input.displayOrder ?? 0,
    })
    .returning();

  return result[0];
}

export async function updateLineItem(
  tenantDb: TenantDb,
  itemId: string,
  dealId: string,
  input: UpdateLineItemInput
) {
  const [existing] = await tenantDb
    .select({ item: estimateLineItems, dealId: estimateSections.dealId })
    .from(estimateLineItems)
    .innerJoin(estimateSections, eq(estimateLineItems.sectionId, estimateSections.id))
    .where(and(eq(estimateLineItems.id, itemId), eq(estimateSections.dealId, dealId)))
    .limit(1);

  if (!existing) throw new AppError(404, "Line item not found");

  const existingItem = existing.item;

  const updates: Record<string, any> = {};
  if (input.description !== undefined) updates.description = input.description.trim();
  if (input.unit !== undefined) updates.unit = input.unit;
  if (input.notes !== undefined) updates.notes = input.notes;
  if (input.displayOrder !== undefined) updates.displayOrder = input.displayOrder;

  // Recalculate totalPrice if quantity or unitPrice changed
  const newQuantity =
    input.quantity !== undefined ? String(input.quantity) : existingItem.quantity;
  const newUnitPrice =
    input.unitPrice !== undefined ? String(input.unitPrice) : existingItem.unitPrice;

  if (input.quantity !== undefined) updates.quantity = newQuantity;
  if (input.unitPrice !== undefined) updates.unitPrice = newUnitPrice;

  if (input.quantity !== undefined || input.unitPrice !== undefined) {
    updates.totalPrice = calcTotal(newQuantity, newUnitPrice);
  }

  if (Object.keys(updates).length === 0) return existingItem;

  updates.updatedAt = new Date();

  const result = await tenantDb
    .update(estimateLineItems)
    .set(updates)
    .where(eq(estimateLineItems.id, itemId))
    .returning();

  return result[0];
}

export async function deleteLineItem(tenantDb: TenantDb, itemId: string, dealId: string) {
  // Verify ownership: line item's section must belong to this deal
  const [existing] = await tenantDb
    .select({ id: estimateLineItems.id })
    .from(estimateLineItems)
    .innerJoin(estimateSections, eq(estimateLineItems.sectionId, estimateSections.id))
    .where(and(eq(estimateLineItems.id, itemId), eq(estimateSections.dealId, dealId)))
    .limit(1);

  if (!existing) throw new AppError(404, "Line item not found");

  await tenantDb.delete(estimateLineItems).where(eq(estimateLineItems.id, itemId));
}
