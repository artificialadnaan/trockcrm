import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { CompanyVerificationStatus } from "@trock-crm/shared/types";
import { createActivity } from "../activities/service.js";

type TenantDb = NodePgDatabase<typeof schema>;
export type ExistingCustomerStatus = "Existing" | "New";

/**
 * Resolve the recipient list for a company verification email.
 *
 * Order of precedence:
 *   1. The single user identified by companies.assignedApproverUserId, if set
 *      and active.
 *   2. All active users with role admin or director.
 *   3. The legacy COMPANY_VERIFICATION_EMAIL env var as a hardcoded last
 *      resort, so tenants with no admin/director users yet still receive a
 *      notification instead of silently dropping it.
 *
 * The EMAIL_OVERRIDE_RECIPIENT layer in resend-client overrides whatever this
 * returns when set, so dev/staging stays safe.
 */
export async function getActiveAdminDirectorEmails(
  tenantDb: TenantDb,
  options: { assignedApproverUserId?: string | null } = {}
): Promise<string[]> {
  if (options.assignedApproverUserId) {
    const [approver] = await tenantDb
      .select({ email: users.email, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, options.assignedApproverUserId))
      .limit(1);
    if (approver?.isActive && approver.email) {
      return [approver.email];
    }
  }

  const adminDirectorUsers = await tenantDb
    .select({ email: users.email })
    .from(users)
    .where(and(inArray(users.role, ["admin", "director"]), eq(users.isActive, true)));
  const emails = adminDirectorUsers.map((u) => u.email).filter((e): e is string => Boolean(e));
  if (emails.length > 0) {
    return emails;
  }

  const fallback = process.env.COMPANY_VERIFICATION_EMAIL?.trim();
  return fallback ? [fallback] : [];
}

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

export function shouldRequestCompanyVerification(input: {
  computedStatus: ExistingCustomerStatus;
  companyVerificationStatus: CompanyVerificationStatus | null;
  companyVerificationEmailSentAt: Date | string | null;
}) {
  return (
    input.computedStatus === "New" &&
    input.companyVerificationStatus !== "verified" &&
    input.companyVerificationEmailSentAt == null
  );
}

/**
 * Build the verification email body. CTAs are frontend URLs that prompt the
 * recipient to confirm and POST to /api/companies/:id/verify or /reject after
 * normal session auth — no tokenized magic links yet (deferred to a future
 * PR3 if/when we want out-of-app one-click approval).
 */
export function buildCompanyVerificationEmail(input: {
  companyId: string;
  companyName: string;
  leadId: string;
  leadName: string;
  frontendUrl?: string;
}) {
  const baseUrl = (input.frontendUrl ?? process.env.FRONTEND_URL ?? "").replace(/\/$/, "");
  const companyUrl = `${baseUrl}/companies/${input.companyId}`;
  const verifyUrl = `${baseUrl}/companies/${input.companyId}?action=verify`;
  const rejectUrl = `${baseUrl}/companies/${input.companyId}?action=reject`;
  const leadUrl = `${baseUrl}/leads/${input.leadId}`;

  return {
    subject: `Company verification needed: ${input.companyName}`,
    html: `
      <p>A new company needs to be verified before this lead can advance.</p>
      <p><strong>Company:</strong> <a href="${companyUrl}">${input.companyName}</a></p>
      <p><strong>Source lead:</strong> <a href="${leadUrl}">${input.leadName}</a></p>
      <p style="margin-top:24px;">
        <a href="${verifyUrl}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;margin-right:8px;">Approve</a>
        <a href="${rejectUrl}" style="display:inline-block;padding:10px 18px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Reject</a>
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">You'll be asked to sign in if you aren't already.</p>
    `,
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
