import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { createActivity } from "../activities/service.js";

type TenantDb = NodePgDatabase<typeof schema>;
export type ExistingCustomerStatus = "Existing" | "New";

export async function computeExistingCustomerStatus(
  tenantDb: Partial<Pick<TenantDb, "execute">>,
  companyId: string,
  now = new Date(),
  options: { excludeLeadId?: string | null } = {}
): Promise<{ status: ExistingCustomerStatus; hasRecentActivity: boolean }> {
  if (typeof tenantDb.execute !== "function") {
    return {
      status: "New",
      hasRecentActivity: false,
    };
  }

  const windowStart = new Date(now);
  windowStart.setFullYear(windowStart.getFullYear() - 1);
  const excludeLeadPredicate = options.excludeLeadId
    ? sql`AND leads.id <> ${options.excludeLeadId}`
    : sql``;

  const result = await tenantDb.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM leads
      WHERE company_id = ${companyId}
        AND (created_at >= ${windowStart} OR updated_at >= ${windowStart})
        ${excludeLeadPredicate}
      UNION ALL
      SELECT 1
      FROM deals
      WHERE company_id = ${companyId}
        AND (created_at >= ${windowStart} OR updated_at >= ${windowStart})
      UNION ALL
      SELECT 1
      FROM contacts
      WHERE company_id = ${companyId}
        AND (created_at >= ${windowStart} OR updated_at >= ${windowStart})
      UNION ALL
      SELECT 1
      FROM emails
      INNER JOIN contacts ON contacts.id = emails.contact_id
      WHERE contacts.company_id = ${companyId}
        AND emails.sent_at >= ${windowStart}
        AND emails.direction IN ('inbound', 'outbound')
      UNION ALL
      SELECT 1
      FROM activities
      WHERE company_id = ${companyId}
        AND occurred_at >= ${windowStart}
        AND type IN ('call', 'meeting')
    ) AS has_activity
  `);

  const rows = result
    ? ((result as { rows?: Array<{ has_activity?: boolean }> }).rows ??
      (result as unknown as Array<{ has_activity?: boolean }>))
    : [];
  const hasRecentActivity = Boolean(rows[0]?.has_activity);

  return {
    status: hasRecentActivity ? "Existing" : "New",
    hasRecentActivity,
  };
}

export async function markCompanyVerified(
  tenantDb: TenantDb,
  input: {
    companyId: string;
    userId: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const [company] = await tenantDb
    .update(companies)
    .set({
      companyVerificationStatus: "verified",
      companyVerifiedAt: now,
      companyVerifiedBy: input.userId,
      updatedAt: now,
    })
    .where(eq(companies.id, input.companyId))
    .returning();

  if (company) {
    await createActivity(tenantDb, {
      type: "note",
      responsibleUserId: input.userId,
      performedByUserId: input.userId,
      sourceEntityType: "company",
      sourceEntityId: input.companyId,
      companyId: input.companyId,
      subject: "Company verified",
      body: "Company verification marked complete.",
      occurredAt: now.toISOString(),
    });
  }

  return company ?? null;
}

export async function markCompanyRejected(
  tenantDb: TenantDb,
  input: {
    companyId: string;
    userId: string;
    reason?: string | null;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const [company] = await tenantDb
    .update(companies)
    .set({
      companyVerificationStatus: "rejected",
      companyVerificationRejectedAt: now,
      companyVerificationRejectedBy: input.userId,
      updatedAt: now,
    })
    .where(eq(companies.id, input.companyId))
    .returning();

  if (company) {
    const reasonSuffix = input.reason?.trim() ? ` Reason: ${input.reason.trim()}` : "";
    await createActivity(tenantDb, {
      type: "note",
      responsibleUserId: input.userId,
      performedByUserId: input.userId,
      sourceEntityType: "company",
      sourceEntityId: input.companyId,
      companyId: input.companyId,
      subject: "Company verification rejected",
      body: `Company verification was rejected.${reasonSuffix}`,
      occurredAt: now.toISOString(),
    });
  }

  return company ?? null;
}
