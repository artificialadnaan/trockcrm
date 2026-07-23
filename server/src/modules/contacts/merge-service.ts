import { eq, and, or, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  contacts,
  contactDealAssociations,
  dealTeamMembers,
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
import {
  revokeCorrectiveActionTokensForRemovedMember,
  type TeamMutationOffice,
} from "../deals/team-service.js";
import { restartCorrectiveActionNotificationCycleForDeal } from "../field/corrective-actions-service.js";

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
  queueEntryId?: string,
  // Threaded from the merge route (id + `office_<slug>`) so a merge that repoints an active super/PM assignment
  // to a winner with a DIFFERENT email can restart each affected deal's open corrective-action cycle (finding
  // P2). Optional so legacy/direct callers still type-check; when absent the re-notify is skipped (the token
  // revoke still runs), best-effort — matching the archive/email-edit paths.
  office?: TeamMutationOffice,
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

  // 4f. Repoint contact-backed deal_team_members rows from loser to winner. Mirrors transferAssociations'
  // conflict handling: the partial unique index deal_team_members_deal_contact_role_uidx forbids two ACTIVE
  // rows for the same (deal_id, contact_id, role), so where the winner is already an active member of the
  // same deal+role, deactivate the loser's now-duplicate row instead of repointing it (which would collide);
  // otherwise repoint. Inactive loser rows can always be repointed (the index only constrains active rows).
  const loserTeamRows = await tenantDb
    .select()
    .from(dealTeamMembers)
    .where(eq(dealTeamMembers.contactId, loserId));

  // Deals where the loser was an ACTIVE super/PM — the assignments the merge repoints (or drops on collision)
  // to the winner. If the winner resolves to a DIFFERENT email than the loser, verify-time revalidation 403s
  // the loser-email token already delivered for that deal's open corrective-action card while the sent stamp
  // stays set → the winner is never (re)notified. Capture these deals BEFORE the repoint below; the restart
  // after the merge writes re-sends a fresh link to the winner's email. Distinct deal ids only (finding P2).
  const responderDealIds = Array.from(
    new Set(
      loserTeamRows
        .filter((r) => r.isActive && (r.role === "superintendent" || r.role === "project_manager"))
        .map((r) => r.dealId),
    ),
  );

  if (loserTeamRows.length > 0) {
    const winnerActiveRows = await tenantDb
      .select({ dealId: dealTeamMembers.dealId, role: dealTeamMembers.role })
      .from(dealTeamMembers)
      .where(and(eq(dealTeamMembers.contactId, winnerId), eq(dealTeamMembers.isActive, true)));
    const winnerActiveKeys = new Set(winnerActiveRows.map((r) => `${r.dealId}::${r.role}`));
    for (const row of loserTeamRows) {
      const collides = row.isActive && winnerActiveKeys.has(`${row.dealId}::${row.role}`);
      if (collides) {
        // Winner already covers this deal+role actively → drop the loser's duplicate instead of repointing.
        await tenantDb
          .update(dealTeamMembers)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(dealTeamMembers.id, row.id));
      } else {
        await tenantDb
          .update(dealTeamMembers)
          .set({ contactId: winnerId, updatedAt: new Date() })
          .where(eq(dealTeamMembers.id, row.id));
      }
    }
  }

  // 6. Absorb missing fields from loser into winner
  const winnerContact = winnerContact0;
  const loserContact = loserContact0;
  const absorb: Record<string, any> = {};
  if (!winnerContact.email && loserContact.email) absorb.email = loserContact.email;
  if (!winnerContact.phone && loserContact.phone) absorb.phone = loserContact.phone;
  if (!winnerContact.mobile && loserContact.mobile) absorb.mobile = loserContact.mobile;
  if (!winnerContact.companyName && loserContact.companyName) absorb.companyName = loserContact.companyName;
  if (!winnerContact.jobTitle && loserContact.jobTitle) absorb.jobTitle = loserContact.jobTitle;
  // Absorb the loser's mailing address: as a UNIT when the winner's is incomplete but the loser's is complete
  // (so a merged billing contact isn't left with a partial/mixed address), otherwise field-by-field to fill the
  // winner's empty fields — so a merge never DISCARDS the loser's partial address data. Fixes both the prior
  // street-only absorption (dropped city/state/ZIP) and the regression that discarded partial data (Codex P2).
  Object.assign(absorb, billingAddressToAbsorb(winnerContact, loserContact));

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

  // 8b. Restart the open corrective-action cycle on each deal where the loser was an active super/PM, when the
  // winner resolves to a DIFFERENT email (finding P2). The winner's FINAL email is what it has after absorb:
  // if the winner had no email it took the loser's (absorb.email) → same address, no stranding; otherwise the
  // winner keeps its own email. Compare case-insensitively (getContactById + revalidation lower-case). When the
  // emails match, the delivered token still resolves to the same active assignment → nothing to restart. When
  // they differ, the loser-email token is now orphaned (loser soft-deleted, assignment repointed): revoke it and
  // restart the cycle so the worker re-sends a working link to the winner's email. Best-effort: only when office
  // was threaded (else responderDealIds is unused). Runs in the caller's tenant transaction (the merge route
  // commits all of it together), mirroring the archive/email-edit paths.
  const winnerFinalEmail = "email" in absorb ? absorb.email : winnerContact.email;
  const loserEmailNorm = loserContact.email?.toLowerCase() ?? null;
  const winnerEmailNorm = (winnerFinalEmail as string | null | undefined)?.toLowerCase() ?? null;
  const responderEmailChanged = loserEmailNorm !== winnerEmailNorm;
  if (office && responderEmailChanged && responderDealIds.length > 0) {
    for (const dealId of responderDealIds) {
      // The loser-email token no longer matches any active super/PM assignment on the deal (the loser is
      // soft-deleted, its assignment now points at the winner). Revoke it so the stale link stops authorizing;
      // the shared helper is a no-op when another active responder still resolves to the loser's email.
      await revokeCorrectiveActionTokensForRemovedMember(tenantDb, dealId, {
        userId: null,
        contactId: null,
        memberEmail: loserContact.email ?? null,
      });
      await restartCorrectiveActionNotificationCycleForDeal(tenantDb, { dealId, office });
    }
  }

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
