import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { CompanyVerificationStatus } from "@trock-crm/shared/types";
import { sendSystemEmail } from "../../lib/resend-client.js";
import { createActivity } from "../activities/service.js";

type TenantDb = NodePgDatabase<typeof schema>;
export type ExistingCustomerStatus = "Existing" | "New";

export function getCompanyVerificationRecipient() {
  return process.env.COMPANY_VERIFICATION_EMAIL?.trim() || "adnaan.iqbal@gmail.com";
}

export async function computeExistingCustomerStatus(
  tenantDb: Pick<TenantDb, "execute">,
  companyId: string,
  now = new Date()
): Promise<{ status: ExistingCustomerStatus; hasRecentActivity: boolean }> {
  const windowStart = new Date(now);
  windowStart.setFullYear(windowStart.getFullYear() - 1);

  const result = await tenantDb.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM leads
      WHERE company_id = ${companyId}
        AND (created_at >= ${windowStart} OR updated_at >= ${windowStart})
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

  const rows =
    (result as { rows?: Array<{ has_activity?: boolean }> }).rows ??
    (result as unknown as Array<{ has_activity?: boolean }>);
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

export function buildCompanyVerificationEmail(input: {
  companyId: string;
  companyName: string;
  leadId: string;
  leadName: string;
}) {
  return {
    subject: `Company verification needed: ${input.companyName}`,
    html: `
      <p>A new company needs to be verified before sales validation.</p>
      <p><strong>Company:</strong> ${input.companyName}</p>
      <p><strong>Lead:</strong> ${input.leadName}</p>
      <p><a href="/companies/${input.companyId}">Open company</a></p>
      <p><a href="/leads/${input.leadId}">Open source lead</a></p>
    `,
  };
}

export async function maybeRequestCompanyVerification(
  tenantDb: TenantDb,
  input: {
    companyId: string;
    companyName: string;
    leadId: string;
    leadName: string;
    userId: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const computed = await computeExistingCustomerStatus(tenantDb, input.companyId, now);
  const [company] = await tenantDb
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);

  if (!company) {
    return computed;
  }

  if (computed.status === "Existing") {
    if (company.companyVerificationStatus !== "not_required") {
      await tenantDb
        .update(companies)
        .set({ companyVerificationStatus: "not_required", updatedAt: now })
        .where(eq(companies.id, input.companyId));
    }
    return computed;
  }

  if (
    !shouldRequestCompanyVerification({
      computedStatus: computed.status,
      companyVerificationStatus: company.companyVerificationStatus,
      companyVerificationEmailSentAt: company.companyVerificationEmailSentAt,
    })
  ) {
    return computed;
  }

  const recipient = getCompanyVerificationRecipient();
  const email = buildCompanyVerificationEmail(input);
  const sent = await sendSystemEmail(recipient, email.subject, email.html);

  await tenantDb
    .update(companies)
    .set({
      companyVerificationStatus: "pending",
      companyVerificationRequestedAt: company.companyVerificationRequestedAt ?? now,
      companyVerificationEmailSentAt: sent ? now : company.companyVerificationEmailSentAt,
      updatedAt: now,
    })
    .where(eq(companies.id, input.companyId));

  await createActivity(tenantDb, {
    type: "email",
    responsibleUserId: input.userId,
    performedByUserId: input.userId,
    sourceEntityType: "company",
    sourceEntityId: input.companyId,
    companyId: input.companyId,
    leadId: input.leadId,
    subject: email.subject,
    body: `Company verification email sent to ${recipient}.`,
    occurredAt: now.toISOString(),
  });

  return computed;
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
