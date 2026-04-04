import { eq, and, desc, sql, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { emails, activities, contacts, deals, contactDealAssociations, tasks } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { graphRequest } from "../../lib/graph-client.js";
import { getValidAccessToken, isGraphAuthConfigured } from "./graph-auth.js";
import { evaluateTaskRules } from "../tasks/rules/evaluator.js";
import { TASK_RULES } from "../tasks/rules/config.js";
import { createTenantTaskRulePersistence } from "../tasks/rules/persistence.js";
import crypto from "crypto";

type TenantDb = NodePgDatabase<typeof schema>;
type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface SendEmailInput {
  to: string[];
  cc?: string[];
  subject: string;
  bodyHtml: string;
  dealId?: string | null;
  contactId?: string | null;
}

export interface EmailFilters {
  dealId?: string;
  contactId?: string;
  direction?: "inbound" | "outbound";
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Send an email via MS Graph API and log it in the emails table.
 */
export async function sendEmail(
  tenantDb: TenantDb,
  userId: string,
  input: SendEmailInput
): Promise<any> {
  // Dev mode: store email locally without sending via Graph
  if (!isGraphAuthConfigured()) {
    return createMockSentEmail(tenantDb, userId, input);
  }

  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    throw new AppError(401, "Email not connected. Please connect your Microsoft account.", "GRAPH_AUTH_REQUIRED");
  }

  // Draft-first flow: create draft -> get real IDs -> send draft
  // This avoids the race condition with sendMail where we have to poll Sent Items.
  const message = {
    subject: input.subject,
    body: {
      contentType: "HTML",
      content: input.bodyHtml,
    },
    toRecipients: input.to.map((addr) => ({
      emailAddress: { address: addr },
    })),
    ccRecipients: (input.cc ?? []).map((addr) => ({
      emailAddress: { address: addr },
    })),
  };

  // Step 1: Create draft — returns the message with real id + conversationId
  const draftResult = await graphRequest<any>({
    accessToken,
    method: "POST",
    path: "/me/messages",
    body: message,
    userId,
  });

  if (!draftResult.ok) {
    if (draftResult.status === 401) {
      throw new AppError(401, "Email session expired. Please reconnect your Microsoft account.", "GRAPH_AUTH_EXPIRED");
    }
    throw new AppError(502, `Failed to create email draft via Microsoft: ${JSON.stringify(draftResult.data)}`);
  }

  const draft = draftResult.data;
  const graphMessageId = draft.id ?? `sent-${crypto.randomUUID()}`;
  const graphConversationId: string | null = draft.conversationId ?? null;
  const fromAddress: string = draft.from?.emailAddress?.address ?? "";

  // Step 2: Send the draft
  const sendResult = await graphRequest({
    accessToken,
    method: "POST",
    path: `/me/messages/${graphMessageId}/send`,
    userId,
  });

  if (!sendResult.ok) {
    if (sendResult.status === 401) {
      throw new AppError(401, "Email session expired. Please reconnect your Microsoft account.", "GRAPH_AUTH_EXPIRED");
    }
    throw new AppError(502, `Failed to send email draft via Microsoft: ${JSON.stringify(sendResult.data)}`);
  }

  // Store the email record
  const [emailRecord] = await tenantDb
    .insert(emails)
    .values({
      graphMessageId,
      graphConversationId,
      direction: "outbound",
      fromAddress,
      toAddresses: input.to,
      ccAddresses: input.cc ?? [],
      subject: input.subject,
      bodyPreview: stripHtml(input.bodyHtml).substring(0, 500),
      bodyHtml: input.bodyHtml,
      hasAttachments: false,
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      userId,
      sentAt: new Date(),
    })
    .returning();

  // Create activity record for the unified feed
  await tenantDb.insert(activities).values({
    type: "email",
    userId,
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
    emailId: emailRecord.id,
    subject: input.subject,
    body: stripHtml(input.bodyHtml).substring(0, 1000),
    occurredAt: new Date(),
  });

  return emailRecord;
}

/**
 * Dev mode: create a mock sent email record without calling Graph API.
 */
async function createMockSentEmail(
  tenantDb: TenantDb,
  userId: string,
  input: SendEmailInput
): Promise<any> {
  const graphMessageId = `dev-sent-${crypto.randomUUID()}`;

  const [emailRecord] = await tenantDb
    .insert(emails)
    .values({
      graphMessageId,
      direction: "outbound",
      fromAddress: "dev-user@trockconstruction.com",
      toAddresses: input.to,
      ccAddresses: input.cc ?? [],
      subject: input.subject,
      bodyPreview: stripHtml(input.bodyHtml).substring(0, 500),
      bodyHtml: input.bodyHtml,
      hasAttachments: false,
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      userId,
      sentAt: new Date(),
    })
    .returning();

  await tenantDb.insert(activities).values({
    type: "email",
    userId,
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
    emailId: emailRecord.id,
    subject: input.subject,
    body: stripHtml(input.bodyHtml).substring(0, 1000),
    occurredAt: new Date(),
  });

  return emailRecord;
}

/**
 * Get emails with filtering, pagination, and optional deal/contact scoping.
 */
export async function getEmails(
  tenantDb: TenantDb,
  filters: EmailFilters,
  userId?: string,
  userRole?: string
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 25;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];

  // RBAC: reps can only see their own emails; directors/admins see all
  if (userId && userRole === "rep") {
    conditions.push(eq(emails.userId, userId));
  }

  if (filters.dealId) {
    conditions.push(eq(emails.dealId, filters.dealId));
  }
  if (filters.contactId) {
    conditions.push(eq(emails.contactId, filters.contactId));
  }
  if (filters.direction) {
    conditions.push(eq(emails.direction, filters.direction));
  }
  if (filters.search && filters.search.trim().length >= 2) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${emails.subject} ILIKE ${term}`,
        sql`${emails.bodyPreview} ILIKE ${term}`,
        sql`${emails.fromAddress} ILIKE ${term}`,
        sql`array_to_string(${emails.toAddresses}, ',') ILIKE ${term}`
      )
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult, emailRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(emails).where(where),
    tenantDb
      .select()
      .from(emails)
      .where(where)
      .orderBy(desc(emails.sentAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    emails: emailRows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single email by ID (includes full body HTML).
 */
export async function getEmailById(tenantDb: TenantDb, emailId: string) {
  const result = await tenantDb
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get all emails in a thread (grouped by graph_conversation_id).
 */
export async function getEmailThread(
  tenantDb: TenantDb,
  conversationId: string,
  userId?: string,
  userRole?: string
) {
  if (!conversationId) return [];

  const conditions: any[] = [eq(emails.graphConversationId, conversationId)];

  // RBAC: reps can only see their own emails in the thread
  if (userId && userRole === "rep") {
    conditions.push(eq(emails.userId, userId));
  }

  // Thread view: chronological order (oldest first) for natural reading context
  return tenantDb
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(sql`${emails.sentAt} ASC`);
}

/**
 * Get emails for a user across all deals/contacts (inbox view).
 */
export async function getUserEmails(tenantDb: TenantDb, userId: string, filters: EmailFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 25;
  const offset = (page - 1) * limit;

  const conditions: any[] = [eq(emails.userId, userId)];

  if (filters.direction) {
    conditions.push(eq(emails.direction, filters.direction));
  }
  if (filters.search && filters.search.trim().length >= 2) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${emails.subject} ILIKE ${term}`,
        sql`${emails.bodyPreview} ILIKE ${term}`,
        sql`${emails.fromAddress} ILIKE ${term}`
      )
    );
  }

  const where = and(...conditions);

  const [countResult, emailRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(emails).where(where),
    tenantDb
      .select()
      .from(emails)
      .where(where)
      .orderBy(desc(emails.sentAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    emails: emailRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Auto-associate an email to a deal based on the contact's active deals.
 *
 * Rules (from spec):
 * - Contact has 1 active deal -> auto-associate email to that deal
 * - Contact has multiple active deals -> leave deal_id NULL, create task for rep
 * - Contact has 0 active deals -> associate to contact only (deal_id stays NULL)
 *
 * Returns the dealId if auto-associated, or null.
 */
export async function autoAssociateEmailToDeal(
  tenantDb: TenantDb,
  tenantClient: Queryable,
  officeId: string,
  officeSlug: string,
  emailId: string,
  contactId: string,
  userId: string
): Promise<string | null> {
  // Find active deals where this contact is associated
  const activeDeals = await tenantDb
    .select({ dealId: deals.id, dealName: deals.name, dealNumber: deals.dealNumber })
    .from(deals)
    .innerJoin(
      contactDealAssociations,
      eq(contactDealAssociations.dealId, deals.id)
    )
    .where(
      and(
        eq(contactDealAssociations.contactId, contactId),
        eq(deals.isActive, true)
      )
    );

  if (activeDeals.length === 1) {
    // Auto-associate to the single active deal
    const dealId = activeDeals[0].dealId;
    await tenantDb
      .update(emails)
      .set({ dealId })
      .where(eq(emails.id, emailId));
    return dealId;
  }

  if (activeDeals.length > 1) {
    const [emailRow] = await tenantDb
      .select({ subject: emails.subject })
      .from(emails)
      .where(eq(emails.id, emailId))
      .limit(1);

    const [contactRow] = await tenantDb
      .select({ firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    await evaluateTaskRules(
      {
        now: new Date(),
        officeId,
        entityId: `email:${emailId}`,
        sourceEvent: "email.received",
        contactId,
        emailId,
        taskAssigneeId: userId,
        contactName: `${contactRow?.firstName ?? ""} ${contactRow?.lastName ?? ""}`.trim() || "contact",
        emailSubject: emailRow?.subject ?? "(No Subject)",
        activeDealCount: activeDeals.length,
        activeDealNames: activeDeals.map((d) => `${d.dealNumber} ${d.dealName}`.trim()),
      },
      createTenantTaskRulePersistence(tenantClient, `office_${officeSlug}`),
      TASK_RULES
    );
    return null;
  }

  // 0 active deals — contact-only association, no deal
  return null;
}

/**
 * Match an email address to a CRM contact.
 * Returns the contact if found, null otherwise.
 */
export async function findContactByEmail(
  tenantDb: TenantDb,
  emailAddress: string
): Promise<{ id: string; firstName: string; lastName: string } | null> {
  const normalized = emailAddress.trim().toLowerCase();
  const result = await tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contacts)
    .where(
      and(
        sql`LOWER(${contacts.email}) = ${normalized}`,
        eq(contacts.isActive, true)
      )
    )
    .limit(1);

  return result[0] ?? null;
}

/**
 * Manually associate an email to a deal (from task or UI action).
 */
export async function associateEmailToDeal(
  tenantDb: TenantDb,
  emailId: string,
  dealId: string
): Promise<void> {
  const email = await getEmailById(tenantDb, emailId);
  if (!email) throw new AppError(404, "Email not found");

  const deal = await tenantDb
    .select({ id: deals.id })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (deal.length === 0) throw new AppError(404, "Deal not found");

  await tenantDb
    .update(emails)
    .set({ dealId })
    .where(eq(emails.id, emailId));

  // Cascade: update the associated activity and task records to keep deal_id consistent
  await tenantDb
    .update(activities)
    .set({ dealId })
    .where(eq(activities.emailId, emailId));

  await tenantDb
    .update(tasks)
    .set({ dealId })
    .where(and(eq(tasks.emailId, emailId), eq(tasks.type, "inbound_email")));
}

/**
 * Strip HTML tags for plain-text preview.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
