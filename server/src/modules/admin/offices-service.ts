import { eq, asc } from "drizzle-orm";
import { offices } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { createOffice as provisionOffice } from "../office/service.js";
import { invalidateOfficeCache } from "../../middleware/tenant.js";
import { getOfficeTimezone } from "../../lib/office-timezone.js";

export async function listOffices() {
  return db
    .select()
    .from(offices)
    .orderBy(asc(offices.name));
}

export async function getOfficeById(id: string) {
  const rows = await db
    .select()
    .from(offices)
    .where(eq(offices.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateOfficeInput {
  name: string;
  slug: string;
  address?: string;
  phone?: string;
  timezone?: string | null;
}

/**
 * Create an office AND atomically provision its tenant schema.
 * Delegates to office/service.ts which handles schema creation inside a
 * transaction — prevents the bug where the office row exists but the
 * tenant schema is missing.
 */
export async function createOffice(input: CreateOfficeInput) {
  if (!/^[a-z][a-z0-9_]*$/.test(input.slug)) {
    throw new AppError(
      400,
      "Office slug must be lowercase, start with a letter, and contain only letters, numbers, and underscores"
    );
  }

  // provisionOffice does: slug validation, uniqueness check, INSERT + schema DDL in one transaction
  const office = await provisionOffice(
    input.name,
    input.slug,
    input.address,
    input.phone,
    getOfficeTimezone({ timezone: input.timezone })
  );

  invalidateOfficeCache(office.id);
  return office;
}

export async function updateOffice(
  id: string,
  input: Partial<{
    name: string;
    address: string;
    phone: string;
    timezone: string | null;
    isActive: boolean;
    settings: Record<string, unknown>;
  }>
) {
  const existing = await getOfficeById(id);
  if (!existing) throw new AppError(404, "Office not found");

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.address !== undefined) updates.address = input.address;
  if (input.phone !== undefined) updates.phone = input.phone;
  if (input.timezone !== undefined) updates.timezone = getOfficeTimezone({ timezone: input.timezone });
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.settings !== undefined) updates.settings = input.settings;

  const [updated] = await db
    .update(offices)
    .set(updates)
    .where(eq(offices.id, id))
    .returning();

  // Bust tenant middleware cache so deactivated offices take effect immediately
  invalidateOfficeCache(id);

  return updated;
}
