import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { activities, companies, contacts, deals, leads, properties, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ActivitySourceEntityType = "company" | "property" | "lead" | "deal" | "contact";

export interface CreateActivityInput {
  type: string;
  responsibleUserId: string;
  performedByUserId?: string;
  sourceEntityType: ActivitySourceEntityType;
  sourceEntityId: string;
  companyId?: string;
  propertyId?: string;
  leadId?: string;
  dealId?: string;
  contactId?: string;
  emailId?: string;
  subject?: string;
  body?: string;
  outcome?: string;
  nextStep?: string;
  nextStepDueAt?: string;
  durationMinutes?: number;
  occurredAt?: string;
}

export interface ActivityFilters {
  companyId?: string;
  propertyId?: string;
  leadId?: string;
  dealId?: string;
  contactId?: string;
  responsibleUserId?: string;
  userId?: string;
  viewerUserId?: string;
  sourceEntityType?: ActivitySourceEntityType;
  sourceEntityId?: string;
  type?: string;
  page?: number;
  limit?: number;
}

const SOURCE_ENTITY_LINK_KEY: Record<ActivitySourceEntityType, keyof Pick<
  CreateActivityInput,
  "companyId" | "propertyId" | "leadId" | "dealId" | "contactId"
>> = {
  company: "companyId",
  property: "propertyId",
  lead: "leadId",
  deal: "dealId",
  contact: "contactId",
};

async function addUserMetadata(
  tenantDb: TenantDb,
  rows: Array<typeof activities.$inferSelect>
) {
  const userIds = Array.from(
    new Set(
      rows
        .flatMap((activity) => [activity.responsibleUserId, activity.performedByUserId])
        .filter((id): id is string => Boolean(id))
    )
  );

  if (userIds.length === 0) {
    return rows;
  }

  const userRows = await tenantDb
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, userIds));
  const userById = new Map(userRows.map((user) => [user.id, user]));

  return rows.map((activity) => {
    const responsibleUser = userById.get(activity.responsibleUserId);
    const performedByUser = activity.performedByUserId
      ? userById.get(activity.performedByUserId)
      : null;

    return {
      ...activity,
      responsibleUserName: responsibleUser?.displayName ?? null,
      responsibleUserAvatarUrl: responsibleUser?.avatarUrl ?? null,
      performedByUserName: performedByUser?.displayName ?? null,
      performedByUserAvatarUrl: performedByUser?.avatarUrl ?? null,
    };
  });
}

function normalizeLinkedEntities(input: CreateActivityInput) {
  const linkedEntities = {
    companyId: input.companyId ?? null,
    propertyId: input.propertyId ?? null,
    leadId: input.leadId ?? null,
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
  };

  const sourceLinkKey = SOURCE_ENTITY_LINK_KEY[input.sourceEntityType];
  const existingSourceLink = linkedEntities[sourceLinkKey];

  if (existingSourceLink && existingSourceLink !== input.sourceEntityId) {
    throw new AppError(400, `${sourceLinkKey} must match sourceEntityId`);
  }

  linkedEntities[sourceLinkKey] = input.sourceEntityId;

  return linkedEntities;
}

/**
 * Get activities filtered by deal, contact, or user.
 */
export async function getActivities(
  tenantDb: TenantDb,
  filters: ActivityFilters
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  const responsibleUserId = filters.responsibleUserId ?? filters.userId;

  let dealCondition = filters.dealId ? eq(activities.dealId, filters.dealId) : undefined;

  if (filters.dealId) {
    const [deal] = await tenantDb
      .select({ sourceLeadId: deals.sourceLeadId })
      .from(deals)
      .where(eq(deals.id, filters.dealId))
      .limit(1);

    if (deal?.sourceLeadId) {
      dealCondition = or(
        eq(activities.dealId, filters.dealId),
        eq(activities.leadId, deal.sourceLeadId)
      );
    }
  }

  if (filters.companyId) conditions.push(eq(activities.companyId, filters.companyId));
  if (filters.propertyId) conditions.push(eq(activities.propertyId, filters.propertyId));
  if (filters.leadId) conditions.push(eq(activities.leadId, filters.leadId));
  if (dealCondition) conditions.push(dealCondition);
  if (filters.contactId) conditions.push(eq(activities.contactId, filters.contactId));
  if (responsibleUserId) conditions.push(eq(activities.responsibleUserId, responsibleUserId));
  if (filters.viewerUserId) {
    conditions.push(
      or(
        sql`${activities.type} <> 'email'`,
        eq(activities.responsibleUserId, filters.viewerUserId)
      )
    );
  }
  if (filters.sourceEntityType) {
    conditions.push(eq(activities.sourceEntityType, filters.sourceEntityType as any));
  }
  if (filters.sourceEntityId) conditions.push(eq(activities.sourceEntityId, filters.sourceEntityId));
  if (filters.type) conditions.push(eq(activities.type, filters.type as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(activities).where(where);
  const rows = await tenantDb
    .select()
    .from(activities)
    .where(where)
    .orderBy(desc(activities.occurredAt), desc(activities.createdAt))
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);
  const enrichedRows = await addUserMetadata(tenantDb, rows);

  return {
    activities: enrichedRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Create an activity (call, note, meeting, task_completed).
 * Also updates deals.lastActivityAt if a dealId is provided.
 *
 * NOTE: The existing PG touchpoint_trigger on the activities table automatically
 * handles: incrementing contacts.touchpoint_count, updating contacts.last_contacted_at,
 * and setting contacts.first_outreach_completed = true for call/email/meeting types.
 * We do NOT need to do this in application code.
 */
export async function createActivity(
  tenantDb: TenantDb,
  input: CreateActivityInput
) {
  if (!input.type) throw new AppError(400, "Activity type is required");
  if (!input.responsibleUserId) throw new AppError(400, "responsibleUserId is required");
  if (!input.sourceEntityType) throw new AppError(400, "sourceEntityType is required");
  if (!input.sourceEntityId) throw new AppError(400, "sourceEntityId is required");

  const linkedEntities = normalizeLinkedEntities(input);

  /**
   * The entity this activity is ABOUT must still be live.
   *
   * Scoped to the SOURCE entity, not every id on the row. An activity whose subject is soft-deleted is
   * unreachable — every read filters on is_active — so the rep sees "Logged" and no surface will ever
   * show it. But the other ids are denormalised riders: a site visit sourced to a PROPERTY also carries
   * that property's companyId, and a visit sourced to a CONTACT carries their employer's.
   *
   * Checking all of them was too strict and produced a dead end: `deleteCompany` sets only
   * `companies.is_active = false` and leaves linked contacts active, so a contact whose company was
   * retired is still returned by the picker — and rejecting on its rider companyId meant a valid,
   * selectable person could not receive a visit at all. Reachability follows the SOURCE, so that is
   * what is guarded.
   */
  const sourceGuards: Record<string, () => Promise<boolean>> = {
    property: async () => {
      const [row] = await tenantDb
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.id, input.sourceEntityId), eq(properties.isActive, true)))
        .limit(1);
      return Boolean(row);
    },
    company: async () => {
      const [row] = await tenantDb
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.id, input.sourceEntityId), eq(companies.isActive, true)))
        .limit(1);
      return Boolean(row);
    },
  };
  const guard = sourceGuards[input.sourceEntityType];
  if (guard && !(await guard())) {
    throw new AppError(400, `${input.sourceEntityType === "property" ? "Property" : "Company"} not found`);
  }

  const result = await tenantDb
    .insert(activities)
    .values({
      type: input.type as any,
      responsibleUserId: input.responsibleUserId,
      performedByUserId: input.performedByUserId ?? null,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      companyId: linkedEntities.companyId,
      propertyId: linkedEntities.propertyId,
      leadId: linkedEntities.leadId,
      dealId: linkedEntities.dealId,
      contactId: linkedEntities.contactId,
      emailId: input.emailId ?? null,
      subject: input.subject ?? null,
      body: input.body ?? null,
      outcome: input.outcome ?? null,
      nextStep: input.nextStep ?? null,
      nextStepDueAt: input.nextStepDueAt ? new Date(input.nextStepDueAt) : null,
      durationMinutes: input.durationMinutes ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    })
    .returning();

  const activity = result[0];

  /**
   * Only the DEAL is refreshed here.
   *
   * `properties.last_activity_at` and `companies.last_activity_at` are maintained by the
   * `redesign_last_activity_refresh` trigger from migration 0090, which fires AFTER INSERT/UPDATE/DELETE
   * on activities and recomputes each as `max(occurred_at)` over the table. Writing them here as well —
   * as an earlier version of this did — is not just redundant I/O on rows a busy office touches
   * constantly; it is WEAKER, because GREATEST can only ratchet a value upward while the trigger
   * recomputes correctly when an activity is deleted or re-pointed.
   *
   * Deals are not covered by that trigger, so this stays.
   */
  if (linkedEntities.dealId) {
    await tenantDb
      .update(deals)
      .set({ lastActivityAt: new Date() })
      .where(eq(deals.id, linkedEntities.dealId));
  }

  return activity;
}

/**
 * Record that a captured activity became a lead.
 *
 * WHY THIS IS A SEPARATE STEP rather than a "promote" endpoint that creates the lead itself: lead
 * creation carries office-code resolution, rep assignment, a due-diligence approval dispatch and its
 * own requirements-error contract, all wired into POST /leads. Re-implementing that path for
 * promotion would be a second copy of the rules that decide what a lead IS — the mirroring this
 * codebase has repeatedly paid for. So the client creates the lead through the one endpoint that owns
 * those rules, and this records the linkage.
 *
 * The trade-off, stated rather than hidden: the two calls are not atomic. If this one fails the lead
 * still exists and simply is not linked back — visible, retryable, and harmless, because the lead is
 * the artifact that matters. The reverse ordering (link first) has no such safe failure.
 *
 * IDEMPOTENT. A retry after a dropped response must not look like an error, and re-linking the SAME
 * lead is exactly what a retry does.
 */
export async function linkActivityToLead(
  tenantDb: TenantDb,
  input: { activityId: string; leadId: string; viewer: { id: string; role: string } }
) {
  if (!input.activityId) throw new AppError(400, "activityId is required");
  if (!input.leadId) throw new AppError(400, "leadId is required");
  if (!input.viewer?.id) throw new AppError(400, "viewer is required");

  const [existing] = await tenantDb
    .select()
    .from(activities)
    .where(eq(activities.id, input.activityId))
    .limit(1);

  if (!existing) throw new AppError(404, "Activity not found");

  /**
   * AUTHORISE THE ACTIVITY, not only the lead.
   *
   * Checking access to the target lead alone let a caller pass ANY activity id — including another
   * rep's — and receive the row back. getActivities deliberately hides email activities from everyone
   * but their responsible user, because those rows carry the subject and up to 1000 characters of
   * body; routing around that filter here turned a linking endpoint into a mailbox read.
   *
   * 404, not 403: an id the caller may not touch should not be confirmed to exist.
   */
  const isOwner =
    existing.responsibleUserId === input.viewer.id || existing.performedByUserId === input.viewer.id;
  const isPrivileged = input.viewer.role === "admin" || input.viewer.role === "director";
  if (!isOwner && !(isPrivileged && existing.type !== "email")) {
    throw new AppError(404, "Activity not found");
  }

  if (existing.leadId) {
    /**
     * Same lead — the retry case, and a success.
     *
     * Deliberately ahead of the archived check below, which is about not WRITING to a tombstone. This
     * branch writes nothing: the link already exists, so the honest answer to "did my visit get
     * attached?" is yes. Refusing here would report failure for work that completed, which is how the
     * same promotion gets attempted twice. The late-retry case the archived guard exists for is the
     * one where the FIRST call failed — and there existing.leadId is null, so it still fires.
     */
    if (existing.leadId === input.leadId) return existing;
    // A DIFFERENT lead. Silently repointing would move a visit's history off the lead it created and
    // onto another, so this refuses and says which one holds it.
    throw new AppError(409, "This activity is already linked to a different lead", "ACTIVITY_LEAD_CONFLICT");
  }

  /**
   * The lead must describe the SAME building as the visit.
   *
   * Nothing else checks it: a caller with access to any lead could attach a site visit at one property
   * to a lead at another, and the visit would then appear as that lead's origin. The property is the
   * thing both records agree on, so it is what is compared — and only when the activity actually has
   * one, since a company- or contact-anchored capture legitimately has no property.
   */
  /**
   * The lead is read UNCONDITIONALLY, because its liveness is not a consistency question.
   *
   * Promotion is two calls, so the link can arrive late or be retried after the lead it targets has
   * been archived. assertLeadCollaboratorAccess checks existence and office, not state, so the write
   * landed on the tombstone: the association was recorded and the lead's last-touch refreshed on a row
   * every active view hides. Reading it here rather than only when the activity has other anchors is
   * what makes the check unmissable.
   *
   * ARCHIVED means is_active = false while status is still `open`. A converted or disqualified lead is
   * also inactive, and linking to one is legitimate — that is the normal end of a lead's life, and its
   * originating visit still belongs on it.
   */
  const [lead] = await tenantDb
    .select({
      propertyId: leads.propertyId,
      companyId: leads.companyId,
      isActive: leads.isActive,
      status: leads.status,
    })
    .from(leads)
    .where(eq(leads.id, input.leadId))
    .limit(1)
    /**
     * FOR UPDATE, because an unlocked read makes the guard advisory.
     *
     * Archival locks and updates the lead row. Without taking that lock here, this transaction can read
     * the still-active version, link the activity, and then block on the archival commit before
     * refreshing lastActivityAt — succeeding in precisely the tombstone state the check exists to
     * reject, and touching the archived row on the way out. Taking the lock makes the two serialise:
     * either this sees the row live and archival waits, or it sees it archived and refuses.
     */
    .for("update");
  if (!lead) throw new AppError(404, "Lead not found");
  if (lead.isActive === false && lead.status === "open") {
    throw new AppError(409, "That lead has been archived", "ACTIVITY_LEAD_ARCHIVED");
  }

  if (existing.propertyId || existing.companyId || existing.contactId || existing.dealId) {
    if (existing.propertyId && lead.propertyId && lead.propertyId !== existing.propertyId) {
      throw new AppError(
        409,
        "That lead is for a different property than this visit",
        "ACTIVITY_LEAD_PROPERTY_MISMATCH"
      );
    }
    /**
     * The COMPANY-anchored capture needs the same guard.
     *
     * Skipping validation whenever propertyId was null let an activity for Company A be linked to a
     * lead for Company B — the activity keeps Company A while appearing as the origin of B's lead,
     * which is exactly the cross-record attribution the property check exists to stop. It is also the
     * fallback path, so the case is common rather than exotic.
     */
    if (existing.companyId && lead.companyId && lead.companyId !== existing.companyId) {
      throw new AppError(
        409,
        "That lead is for a different company than this visit",
        "ACTIVITY_LEAD_COMPANY_MISMATCH"
      );
    }
    /**
     * A CONTACT-anchored capture is checked through that contact's company.
     *
     * A log against a person alone carries no property and — when the person was created without one —
     * no company either, so both guards above skipped and any accessible lead could claim it. The
     * contact's own company is the only anchor such a row has.
     */
    /**
     * A DEAL-anchored activity is checked through the deal's company.
     *
     * An activity created with only `dealId` had none of the other anchors, so it skipped every lookup
     * and could be linked to any lead the caller could see — the widest hole of the four, because a
     * deal is the anchor most likely to belong to a different company than the lead being promoted.
     */
    /**
     * Guarded on `!existing.companyId`, matching the contact rule below.
     *
     * An activity that STATES its company has already been checked against the lead's, so re-deriving
     * one from the deal could only overrule the activity's own claim — and a deal whose company was
     * later reassigned would then veto a link the activity and the lead already agree on. Two adjacent
     * branches with two different precedences is the inconsistency, not the strictness.
     */
    if (!existing.companyId && existing.dealId && lead.companyId) {
      const [deal] = await tenantDb
        .select({ companyId: deals.companyId })
        .from(deals)
        .where(eq(deals.id, existing.dealId))
        .limit(1);
      if (deal?.companyId && deal.companyId !== lead.companyId) {
        throw new AppError(
          409,
          "That lead is for a different company than this deal",
          "ACTIVITY_LEAD_COMPANY_MISMATCH"
        );
      }
    }
    if (!existing.companyId && existing.contactId && lead.companyId) {
      const [contact] = await tenantDb
        .select({ companyId: contacts.companyId })
        .from(contacts)
        .where(eq(contacts.id, existing.contactId))
        .limit(1);
      if (contact?.companyId && contact.companyId !== lead.companyId) {
        throw new AppError(
          409,
          "That lead is for a different company than this contact",
          "ACTIVITY_LEAD_COMPANY_MISMATCH"
        );
      }
    }
  }

  /**
   * CONDITIONAL update — the read above cannot hold a claim on the row.
   *
   * Two concurrent promotions both read leadId as null and both write, and the second silently wins:
   * the 409 above never fires because neither request saw the other's value. Requiring leadId to still
   * be null in the UPDATE makes the database the arbiter, and a zero-row result means someone else got
   * there first.
   */
  const [updated] = await tenantDb
    .update(activities)
    .set({ leadId: input.leadId })
    .where(and(eq(activities.id, input.activityId), isNull(activities.leadId)))
    .returning();

  if (updated) {
    /**
     * The lead's last-touch now includes this visit.
     *
     * Linking wrote only activities.lead_id, so a lead promoted from a site visit showed no activity —
     * every surface that sorts or filters on last touch treated a lead created FROM a visit as
     * untouched, which is the opposite of what happened. Best-effort: the link is the authoritative
     * change and must not fail because a denormalised timestamp could not be refreshed.
     */
    /**
     * NOT wrapped in try/catch, and that is the fix rather than an omission.
     *
     * This runs inside the request's transaction. If the UPDATE raises — a statement timeout, a
     * trigger, a constraint — Postgres marks the whole transaction aborted, and catching the
     * JavaScript exception does not undo that: every later statement fails with "current transaction
     * is aborted", including the COMMIT. "Best-effort" is not a thing you can do to a statement inside
     * a transaction by ignoring its error.
     *
     * So it participates properly. Both writes land together or neither does, which is also the
     * honest contract: a link whose lead never registered the visit is half-applied state.
     *
     * GREATEST keeps the column monotonic. A visit linked after the lead has already seen newer
     * activity must not drag last-touch backwards — every surface that sorts by it would then show the
     * lead as going cold because someone filed an older note.
     */
    await tenantDb
      .update(leads)
      .set({
        lastActivityAt: sql`GREATEST(${leads.lastActivityAt}, ${updated.occurredAt ?? new Date()})`,
      })
      .where(eq(leads.id, input.leadId));
    return updated;
  }

  // Lost the race. Re-read to answer with the same rules as above: the winner may have been this very
  // lead (a concurrent retry, which is a success) or a different one (a genuine conflict).
  const [after] = await tenantDb
    .select()
    .from(activities)
    .where(eq(activities.id, input.activityId))
    .limit(1);
  if (after?.leadId === input.leadId) return after;
  throw new AppError(409, "This activity is already linked to a different lead", "ACTIVITY_LEAD_CONFLICT");
}
