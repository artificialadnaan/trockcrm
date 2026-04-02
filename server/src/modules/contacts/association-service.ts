import { eq, and, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contactDealAssociations, contacts, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateAssociationInput {
  contactId: string;
  dealId: string;
  role?: string | null;
  isPrimary?: boolean;
}

/**
 * Get all deals associated with a contact.
 * Reps only see deals assigned to them.
 */
export async function getDealsForContact(
  tenantDb: TenantDb,
  contactId: string,
  userId: string,
  userRole: string
) {
  const associations = await tenantDb
    .select({
      association: contactDealAssociations,
      deal: deals,
    })
    .from(contactDealAssociations)
    .innerJoin(deals, eq(contactDealAssociations.dealId, deals.id))
    .where(eq(contactDealAssociations.contactId, contactId))
    .orderBy(desc(deals.updatedAt));

  const mapped = associations.map((row) => ({
    ...row.association,
    deal: row.deal,
  }));

  // RBAC: reps can only see deals assigned to them
  if (userRole === "rep") {
    return mapped.filter((a) => a.deal.assignedRepId === userId);
  }

  return mapped;
}

/**
 * Get all contacts associated with a deal.
 */
export async function getContactsForDeal(tenantDb: TenantDb, dealId: string) {
  const associations = await tenantDb
    .select({
      association: contactDealAssociations,
      contact: contacts,
    })
    .from(contactDealAssociations)
    .innerJoin(contacts, eq(contactDealAssociations.contactId, contacts.id))
    .where(eq(contactDealAssociations.dealId, dealId))
    .orderBy(desc(contactDealAssociations.createdAt));

  return associations.map((row) => ({
    ...row.association,
    contact: row.contact,
  }));
}

/**
 * Create a contact-deal association.
 */
export async function createAssociation(tenantDb: TenantDb, input: CreateAssociationInput) {
  // Verify contact exists and is active
  const [contact] = await tenantDb
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, input.contactId), eq(contacts.isActive, true)))
    .limit(1);
  if (!contact) throw new AppError(404, "Contact not found or inactive");

  // Verify deal exists and is active
  const [deal] = await tenantDb
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.id, input.dealId), eq(deals.isActive, true)))
    .limit(1);
  if (!deal) throw new AppError(404, "Deal not found or inactive");

  // Check if an association already exists for this contact+deal pair
  // BEFORE clearing old primaries (avoids clearing primary when insert would fail)
  const [existingAssoc] = await tenantDb
    .select({ id: contactDealAssociations.id })
    .from(contactDealAssociations)
    .where(
      and(
        eq(contactDealAssociations.contactId, input.contactId),
        eq(contactDealAssociations.dealId, input.dealId)
      )
    )
    .limit(1);
  if (existingAssoc) {
    throw new AppError(409, "Association already exists");
  }

  // If this is being set as primary, unset other primaries for this deal
  if (input.isPrimary) {
    // Lock the deal row to prevent primary assignment race conditions
    await tenantDb.select().from(deals).where(eq(deals.id, input.dealId)).limit(1).for("update");

    await tenantDb
      .update(contactDealAssociations)
      .set({ isPrimary: false })
      .where(
        and(
          eq(contactDealAssociations.dealId, input.dealId),
          eq(contactDealAssociations.isPrimary, true)
        )
      );
  }

  try {
    const result = await tenantDb
      .insert(contactDealAssociations)
      .values({
        contactId: input.contactId,
        dealId: input.dealId,
        role: input.role ?? null,
        isPrimary: input.isPrimary ?? false,
      })
      .returning();

    // Sync deals.primaryContactId AFTER successful insert to avoid orphaned
    // primaryContactId on duplicate-association errors (unique constraint)
    if (input.isPrimary) {
      await tenantDb
        .update(deals)
        .set({ primaryContactId: input.contactId })
        .where(eq(deals.id, input.dealId));
    }

    return result[0];
  } catch (err: any) {
    // Handle unique constraint violation (contact already associated with deal)
    if (err.code === "23505") {
      throw new AppError(409, "Contact is already associated with this deal");
    }
    throw err;
  }
}

/**
 * Update an association (change role or primary status).
 */
export async function updateAssociation(
  tenantDb: TenantDb,
  associationId: string,
  input: { role?: string | null; isPrimary?: boolean }
) {
  // If setting as primary, unset other primaries for this deal
  if (input.isPrimary) {
    const [existing] = await tenantDb
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, associationId))
      .for("update")
      .limit(1);

    if (!existing) throw new AppError(404, "Association not found");

    // Lock the deal row FIRST to prevent primary assignment race conditions
    await tenantDb.select().from(deals).where(eq(deals.id, existing.dealId)).limit(1).for("update");

    await tenantDb
      .update(contactDealAssociations)
      .set({ isPrimary: false })
      .where(
        and(
          eq(contactDealAssociations.dealId, existing.dealId),
          eq(contactDealAssociations.isPrimary, true)
        )
      );

    // Sync deals.primaryContactId to the new primary contact
    await tenantDb
      .update(deals)
      .set({ primaryContactId: existing.contactId })
      .where(eq(deals.id, existing.dealId));
  }

  // If explicitly unsetting primary, clear deals.primaryContactId if it points to this contact
  if (input.isPrimary === false) {
    const [association] = await tenantDb
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, associationId))
      .limit(1);

    if (association) {
      await tenantDb
        .update(deals)
        .set({ primaryContactId: null })
        .where(
          and(
            eq(deals.id, association.dealId),
            eq(deals.primaryContactId, association.contactId)
          )
        );
    }
  }

  const updates: Record<string, any> = {};
  if (input.role !== undefined) updates.role = input.role;
  if (input.isPrimary !== undefined) updates.isPrimary = input.isPrimary;

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "No fields to update");
  }

  const result = await tenantDb
    .update(contactDealAssociations)
    .set(updates)
    .where(eq(contactDealAssociations.id, associationId))
    .returning();

  if (result.length === 0) throw new AppError(404, "Association not found");
  return result[0];
}

/**
 * Delete an association.
 * If the deleted association was the primary, clear deals.primaryContactId.
 */
export async function deleteAssociation(tenantDb: TenantDb, associationId: string) {
  const result = await tenantDb
    .delete(contactDealAssociations)
    .where(eq(contactDealAssociations.id, associationId))
    .returning();

  if (result.length === 0) throw new AppError(404, "Association not found");

  const deleted = result[0];
  if (deleted.isPrimary) {
    // Clear deals.primaryContactId only if it still points to the deleted contact
    await tenantDb
      .update(deals)
      .set({ primaryContactId: null })
      .where(and(eq(deals.id, deleted.dealId), eq(deals.primaryContactId, deleted.contactId)));
  }

  return deleted;
}

/**
 * Transfer all associations from one contact to another (used in merge).
 * Handles unique constraint conflicts by updating existing associations.
 */
export async function transferAssociations(
  tenantDb: TenantDb,
  fromContactId: string,
  toContactId: string
) {
  // Get all associations for the source contact
  const sourceAssociations = await tenantDb
    .select()
    .from(contactDealAssociations)
    .where(eq(contactDealAssociations.contactId, fromContactId));

  // Get all associations for the target contact (to detect conflicts)
  const targetAssociations = await tenantDb
    .select()
    .from(contactDealAssociations)
    .where(eq(contactDealAssociations.contactId, toContactId));

  const targetDealIds = new Set(targetAssociations.map((a) => a.dealId));

  let transferred = 0;
  let skipped = 0;

  for (const assoc of sourceAssociations) {
    if (targetDealIds.has(assoc.dealId)) {
      // Both contacts are on the same deal — check if the loser has isPrimary
      // or a role that the winner's row lacks, and transfer those values first.
      const winnerAssoc = targetAssociations.find((a) => a.dealId === assoc.dealId);
      if (winnerAssoc) {
        const patch: Record<string, any> = {};
        if (assoc.isPrimary && !winnerAssoc.isPrimary) {
          patch.isPrimary = true;
        }
        if (assoc.role && !winnerAssoc.role) {
          patch.role = assoc.role;
        }
        if (Object.keys(patch).length > 0) {
          await tenantDb
            .update(contactDealAssociations)
            .set(patch)
            .where(eq(contactDealAssociations.id, winnerAssoc.id));
        }
      }

      // Now delete the loser's row — winner already covers this deal
      await tenantDb
        .delete(contactDealAssociations)
        .where(eq(contactDealAssociations.id, assoc.id));
      skipped++;
    } else {
      // Transfer: update contactId from source to target
      await tenantDb
        .update(contactDealAssociations)
        .set({ contactId: toContactId })
        .where(eq(contactDealAssociations.id, assoc.id));
      transferred++;
    }
  }

  return { transferred, skipped };
}
