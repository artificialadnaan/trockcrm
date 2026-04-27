import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { leadStageHistory, leads } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { LeadVerificationRequiredReason } from "@trock-crm/shared/types";
import { getStageBySlug } from "../pipeline/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CompanyVerificationDecision {
  needsVerification: boolean;
  reason: LeadVerificationRequiredReason;
  lastActivityAt: Date | null;
}

/**
 * Returns whether a company needs lead-creation verification, based on whether
 * the company has had any meaningful activity in the last 365 days.
 *
 * Single round-trip: one query takes MAX over a UNION ALL of every activity
 * source. Returns NULL when the company has never had any activity.
 *
 * Column choice — real human activity, not automated touches:
 *   - leads/deals: created_at and last_activity_at (skipping updated_at; sync
 *     jobs touch updated_at on every Procore/HubSpot poll, which would mask
 *     genuinely dormant companies as "active").
 *   - contacts: created_at only (updates can be sync-driven).
 *   - activities: occurred_at — the dedicated event-time column. Captures
 *     notes, calls, meetings, manually-logged emails.
 *   - emails: sent_at, filtered to direction IN ('inbound','outbound'). The
 *     emails table has no company_id; an email reaches a company two ways:
 *       (a) via emails.contact_id → contacts.company_id, or
 *       (b) via emails.assigned_entity_type='company' + assigned_entity_id.
 *     Both paths must be UNION'd or generic info@ / system mail tied to the
 *     company without a contact would be silently dropped.
 *
 * Boundary: 365 days inclusive. A row with last_activity_at exactly equal to
 * (now - 365 days) is treated as "still active" — falls through to
 * active_company. We use strict less-than against the cutoff so the edge
 * stays on the active side.
 *
 * "No activity ever" vs "older than 365 days":
 *   - lastActivityAt === null  → 'new_company'
 *   - lastActivityAt < cutoff  → 'dormant_company'
 *   - else                     → 'active_company'
 *
 * Brand-new companies (created during this lead's request) also surface as
 * 'new_company': nothing in the activity sources references the freshly
 * inserted company yet, so MAX returns NULL.
 */
export async function companyNeedsVerification(
  tenantDb: Partial<Pick<TenantDb, "execute">>,
  companyId: string,
  options: {
    excludeLeadId?: string | null;
    now?: Date;
  } = {}
): Promise<CompanyVerificationDecision> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  if (typeof tenantDb.execute !== "function") {
    // Defensive parity with computeExistingCustomerStatus: in mocks/test stubs
    // that omit raw-SQL execution, treat as no activity.
    return { needsVerification: true, reason: "new_company", lastActivityAt: null };
  }

  const excludeLeadId = options.excludeLeadId ?? null;

  const result = await tenantDb.execute(sql`
    SELECT GREATEST(
      (SELECT MAX(GREATEST(created_at, COALESCE(last_activity_at, created_at)))
         FROM leads
        WHERE company_id = ${companyId}
          AND (${excludeLeadId}::uuid IS NULL OR id <> ${excludeLeadId}::uuid)),
      (SELECT MAX(GREATEST(created_at, COALESCE(last_activity_at, created_at)))
         FROM deals
        WHERE company_id = ${companyId}),
      (SELECT MAX(created_at)
         FROM contacts
        WHERE company_id = ${companyId}),
      (SELECT MAX(occurred_at)
         FROM activities
        WHERE company_id = ${companyId}),
      (SELECT MAX(sent_at) FROM (
         SELECT e.sent_at
           FROM emails e
           JOIN contacts c ON c.id = e.contact_id
          WHERE c.company_id = ${companyId}
            AND e.direction IN ('inbound','outbound')
         UNION ALL
         SELECT e.sent_at
           FROM emails e
          WHERE e.assigned_entity_type = 'company'
            AND e.assigned_entity_id = ${companyId}
            AND e.direction IN ('inbound','outbound')
       ) AS company_emails)
    ) AS last_activity_at
  `);

  const rows =
    (result as { rows?: Array<{ last_activity_at?: Date | string | null }> }).rows ??
    (result as unknown as Array<{ last_activity_at?: Date | string | null }>);
  const raw = rows?.[0]?.last_activity_at ?? null;
  const lastActivityAt = raw == null ? null : raw instanceof Date ? raw : new Date(raw);

  if (lastActivityAt == null) {
    return { needsVerification: true, reason: "new_company", lastActivityAt: null };
  }

  if (lastActivityAt < cutoff) {
    return { needsVerification: true, reason: "dormant_company", lastActivityAt };
  }

  return { needsVerification: false, reason: "active_company", lastActivityAt };
}

/**
 * Manually mark a pending lead as verified and auto-promote it to the
 * Qualified Lead stage. Mirrors the structure of the createLead auto-promote
 * branch: writes verification_status='approved' and inserts a lead_stage_history
 * row capturing the synthetic stage transition.
 *
 * Returns null if the lead does not exist or is not currently pending verification.
 */
export async function markLeadVerified(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    userId: string;
    now?: Date;
  }
): Promise<typeof leads.$inferSelect | null> {
  const now = input.now ?? new Date();

  const [existing] = await tenantDb
    .select()
    .from(leads)
    .where(eq(leads.id, input.leadId))
    .limit(1);

  if (!existing) {
    return null;
  }

  if (existing.verificationStatus !== "pending") {
    return null;
  }

  const qualifiedStage = await getStageBySlug("qualified_lead", "lead");
  if (!qualifiedStage) {
    throw new Error("Canonical 'qualified_lead' stage is not configured");
  }

  const [updated] = await tenantDb
    .update(leads)
    .set({
      verificationStatus: "approved",
      stageId: qualifiedStage.id,
      stageEnteredAt: now,
      updatedAt: now,
    })
    .where(eq(leads.id, input.leadId))
    .returning();

  if (existing.stageId !== qualifiedStage.id) {
    await tenantDb.insert(leadStageHistory).values({
      leadId: input.leadId,
      fromStageId: existing.stageId,
      toStageId: qualifiedStage.id,
      changedBy: input.userId,
      isBackwardMove: false,
      durationInPreviousStage: null,
      createdAt: now,
    });
  }

  return updated ?? null;
}
