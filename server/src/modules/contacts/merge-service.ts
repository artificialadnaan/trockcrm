import { eq, and, or, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  contacts,
  contactDealAssociations,
  deals,
  duplicateQueue,
  emails,
  activities,
  files,
  tasks,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { billingAddressToAbsorb } from "../../lib/billing-address.js";
import { transferAssociations } from "./association-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Get pending duplicate queue entries with contact details.
 */
export async function getDuplicateQueue(
  tenantDb: TenantDb,
  filters: { status?: string; page?: number; limit?: number }
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = (page - 1) * limit;
  const status = filters.status ?? "pending";

  // Use raw SQL for the self-join since Drizzle aliasing with same table is verbose
  // Fetch queue entries with both contact records inline
  const queueEntries = await tenantDb
    .select()
    .from(duplicateQueue)
    .where(eq(duplicateQueue.status, status as any))
    .orderBy(desc(duplicateQueue.createdAt))
    .limit(limit)
    .offset(offset);

  const countResult = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(duplicateQueue)
    .where(eq(duplicateQueue.status, status as any));

  // Enrich with contact data. Keep tenantDb reads serialized because request
  // transactions share one client connection.
  const enriched = [];
  for (const entry of queueEntries) {
    const contactA = await tenantDb.select().from(contacts).where(eq(contacts.id, entry.contactAId)).limit(1);
    const contactB = await tenantDb.select().from(contacts).where(eq(contacts.id, entry.contactBId)).limit(1);
    enriched.push({
      ...entry,
      contactA: contactA[0] ?? null,
      contactB: contactB[0] ?? null,
    });
  }

  return {
    entries: enriched,
    pagination: {
      page,
      limit,
      total: Number(countResult[0]?.count ?? 0),
      totalPages: Math.ceil(Number(countResult[0]?.count ?? 0) / limit),
    },
  };
}

/**
 * Merge two contacts.
 *
 * 1. Lock both contacts FOR UPDATE (prevents concurrent merges)
 * 2. Verify both exist and are active
 * 3. If queueEntryId provided: validate it matches the winner/loser pair
 * 4. Transfer ALL associations to winner:
 *    - contact_deal_associations (with overlap handling)
 *    - emails (contact_id FK)
 *    - activities (contact_id FK)
 *    - files (contact_id FK)
 *    - tasks (contact_id FK)
 * 5. Update deals.primaryContactId from loser to winner
 * 6. Absorb missing fields from loser into winner
 * 7. Sum touchpoint counts
 * 8. Soft-delete loser
 * 9. Update duplicate_queue entries referencing loser
 *
 * All operations happen in the caller's transaction.
 */
export async function mergeContacts(
  tenantDb: TenantDb,
  winnerId: string,
  loserId: string,
  resolvedBy: string,
  queueEntryId?: string
) {
  if (winnerId === loserId) {
    throw new AppError(400, "Cannot merge a contact with itself");
  }

  // 1. Lock both contacts FOR UPDATE in deterministic order to prevent deadlocks
  const [firstId, secondId] = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
  const [first] = await tenantDb.select().from(contacts).where(eq(contacts.id, firstId)).limit(1).for("update");
  const [second] = await tenantDb.select().from(contacts).where(eq(contacts.id, secondId)).limit(1).for("update");
  const winnerContact0 = firstId === winnerId ? first : second;
  const loserContact0 = firstId === loserId ? first : second;

  // 2. Verify both exist and are active
  if (!winnerContact0) throw new AppError(404, "Winner contact not found");
  if (!loserContact0) throw new AppError(404, "Loser contact not found");
  if (!winnerContact0.isActive) throw new AppError(400, "Winner contact is not active");
  if (!loserContact0.isActive) throw new AppError(400, "Loser contact is not active");

  // 3. If queueEntryId provided, validate it matches the winner/loser pair
  if (queueEntryId) {
    const [queueEntry] = await tenantDb
      .select()
      .from(duplicateQueue)
      .where(eq(duplicateQueue.id, queueEntryId))
      .limit(1);

    if (!queueEntry) {
      throw new AppError(404, "Duplicate queue entry not found");
    }

    const ids = new Set([queueEntry.contactAId, queueEntry.contactBId]);
    if (!ids.has(winnerId) || !ids.has(loserId)) {
      throw new AppError(
        400,
        "winnerId/loserId do not match the contacts in this duplicate queue entry"
      );
    }
  }

  // 4. Transfer contact_deal_associations
  const assocResult = await transferAssociations(tenantDb, loserId, winnerId);

  // 5. Update deals.primaryContactId from loser to winner
  await tenantDb
    .update(deals)
    .set({ primaryContactId: winnerId })
    .where(eq(deals.primaryContactId, loserId));

  // 5b. Same for deals.billingContactId — otherwise a merged-away billing contact leaves deals pointing at
  // the soft-deleted loser and Billing shows a stale record instead of the surviving contact (Codex P2).
  await tenantDb
    .update(deals)
    .set({ billingContactId: winnerId })
    .where(eq(deals.billingContactId, loserId));

  // 4b. Transfer emails (update contact_id from loser to winner)
  const emailResult = await tenantDb
    .update(emails)
    .set({ contactId: winnerId })
    .where(eq(emails.contactId, loserId))
    .returning({ id: emails.id });

  // 4c. Transfer activities
  const activityResult = await tenantDb
    .update(activities)
    .set({ contactId: winnerId })
    .where(eq(activities.contactId, loserId))
    .returning({ id: activities.id });

  // 4d. Transfer files
  const fileResult = await tenantDb
    .update(files)
    .set({ contactId: winnerId })
    .where(eq(files.contactId, loserId))
    .returning({ id: files.id });

  // 4e. Transfer tasks
  await tenantDb
    .update(tasks)
    .set({ contactId: winnerId })
    .where(eq(tasks.contactId, loserId));

  // 6. Absorb missing fields from loser into winner
  const winnerContact = winnerContact0;
  const loserContact = loserContact0;
  const absorb: Record<string, any> = {};
  if (!winnerContact.email && loserContact.email) absorb.email = loserContact.email;
  if (!winnerContact.phone && loserContact.phone) absorb.phone = loserContact.phone;
  if (!winnerContact.mobile && loserContact.mobile) absorb.mobile = loserContact.mobile;
  if (!winnerContact.companyName && loserContact.companyName) absorb.companyName = loserContact.companyName;
  if (!winnerContact.jobTitle && loserContact.jobTitle) absorb.jobTitle = loserContact.jobTitle;
  // Absorb the loser's mailing address as a UNIT when the winner's is incomplete but the loser's is complete —
  // so merging a complete billing contact into an address-less/partial winner leaves the winner (now the deal's
  // billing contact, per the repoint above) with a full address, not a mixed/incomplete one. Fixes the prior
  // street-only absorption that dropped city/state/ZIP (Codex P2).
  const billingAbsorb = billingAddressToAbsorb(winnerContact, loserContact);
  if (billingAbsorb) Object.assign(absorb, billingAbsorb);

  // 7. Sum touchpoint counts and keep most recent last_contacted_at
  absorb.touchpointCount = (winnerContact.touchpointCount ?? 0) + (loserContact.touchpointCount ?? 0);
  if (loserContact.lastContactedAt) {
    if (!winnerContact.lastContactedAt || loserContact.lastContactedAt > winnerContact.lastContactedAt) {
      absorb.lastContactedAt = loserContact.lastContactedAt;
    }
  }
  if (loserContact.firstOutreachCompleted && !winnerContact.firstOutreachCompleted) {
    absorb.firstOutreachCompleted = true;
  }

  if (Object.keys(absorb).length > 0) {
    await tenantDb
      .update(contacts)
      .set(absorb)
      .where(eq(contacts.id, winnerId));
  }

  // 8. Soft-delete the loser
  await tenantDb
    .update(contacts)
    .set({ isActive: false })
    .where(eq(contacts.id, loserId));

  // 9. Update duplicate_queue entry if provided
  if (queueEntryId) {
    await tenantDb
      .update(duplicateQueue)
      .set({
        status: "merged" as any,
        resolvedBy,
        resolvedAt: new Date(),
      })
      .where(eq(duplicateQueue.id, queueEntryId));
  }

  // Resolve ALL pending duplicate_queue entries that reference the loser
  // (not just the exact winner/loser pair) since the loser no longer exists
  await tenantDb
    .update(duplicateQueue)
    .set({ status: "dismissed" as any, resolvedBy, resolvedAt: new Date() })
    .where(
      and(
        eq(duplicateQueue.status, "pending" as any),
        or(eq(duplicateQueue.contactAId, loserId), eq(duplicateQueue.contactBId, loserId))
      )
    );

  return {
    winnerId,
    loserId,
    transferred: {
      dealAssociations: assocResult.transferred,
      dealAssociationsSkipped: assocResult.skipped,
      emails: emailResult.length,
      activities: activityResult.length,
      files: fileResult.length,
    },
    absorbed: Object.keys(absorb),
  };
}

/**
 * Dismiss a duplicate queue entry (mark as not-a-duplicate).
 */
export async function dismissDuplicate(
  tenantDb: TenantDb,
  queueEntryId: string,
  resolvedBy: string
) {
  const result = await tenantDb
    .update(duplicateQueue)
    .set({
      status: "dismissed" as any,
      resolvedBy,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(duplicateQueue.id, queueEntryId),
        eq(duplicateQueue.status, "pending" as any)
      )
    )
    .returning();

  if (result.length === 0) {
    throw new AppError(404, "Queue entry not found or already resolved");
  }

  return result[0];
}
