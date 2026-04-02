import { eq, asc } from "drizzle-orm";
import { offices } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

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
}

export async function createOffice(input: CreateOfficeInput) {
  if (!/^[a-z][a-z0-9_]*$/.test(input.slug)) {
    throw new AppError(
      400,
      "Office slug must be lowercase, start with a letter, and contain only letters, numbers, and underscores"
    );
  }

  const existing = await db
    .select({ id: offices.id })
    .from(offices)
    .where(eq(offices.slug, input.slug))
    .limit(1);

  if (existing[0]) {
    throw new AppError(409, `Office slug "${input.slug}" is already in use`);
  }

  const [office] = await db
    .insert(offices)
    .values({
      name: input.name,
      slug: input.slug,
      address: input.address ?? null,
      phone: input.phone ?? null,
      isActive: true,
      settings: {},
    })
    .returning();

  return office;
}

export async function updateOffice(
  id: string,
  input: Partial<{ name: string; address: string; phone: string; isActive: boolean; settings: Record<string, unknown> }>
) {
  const existing = await getOfficeById(id);
  if (!existing) throw new AppError(404, "Office not found");

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.address !== undefined) updates.address = input.address;
  if (input.phone !== undefined) updates.phone = input.phone;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.settings !== undefined) updates.settings = input.settings;

  const [updated] = await db
    .update(offices)
    .set(updates)
    .where(eq(offices.id, id))
    .returning();

  return updated;
}
