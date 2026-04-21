import { eq, and, desc, sql, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  pipelineStageConfig,
  jobQueue,
  emails,
  emailThreadBindings,
  activities,
  companies,
  contacts,
  deals,
  leads,
  properties,
  contactDealAssociations,
  tasks,
  userGraphTokens,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { graphRequest } from "../../lib/graph-client.js";
import { getValidAccessToken, isGraphAuthConfigured } from "./graph-auth.js";
import { completeTask } from "../tasks/service.js";
import { evaluateTaskRules } from "../tasks/rules/evaluator.js";
import { TASK_RULES } from "../tasks/rules/config.js";
import { createTenantTaskRulePersistence } from "../tasks/rules/persistence.js";
import {
  resolveEmailAssignment,
  buildPropertyCandidatesFromDeals,
  buildLeadCandidatesFromDeals,
  type EmailAssignmentDealCandidate,
  type EmailAssignmentLeadCandidate,
  type EmailAssignmentPropertyCandidate,
  type EmailAssignmentEntityType,
  type EmailAssignmentResult,
  type EmailAssignmentThreadAssignment,
} from "./assignment-service.js";
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

export interface EmailAssignmentQueueFilters {
  search?: string;
  page?: number;
  limit?: number;
}

export interface EmailAssignmentQueueItem {
  email: Awaited<ReturnType<typeof getEmailById>>;
  companyId: string | null;
  contactName: string | null;
  companyName: string | null;
  candidateDeals: EmailAssignmentDealCandidate[];
  candidateLeads: EmailAssignmentLeadCandidate[];
  candidateProperties: EmailAssignmentPropertyCandidate[];
  suggestedAssignment: EmailAssignmentResult;
}

export function isEmailAssignmentQueueCandidate(emailRow: {
  direction: "inbound" | "outbound";
  assignmentAmbiguityReason: string | null;
}) {
  return emailRow.direction === "inbound" && emailRow.assignmentAmbiguityReason != null;
}

type ThreadBindingRecord = typeof emailThreadBindings.$inferSelect;

export interface EmailThreadResponse {
  binding: {
    id: string;
    mailboxAccountId: string;
    contactId: string | null;
    contactName: string | null;
    companyId: string | null;
    companyName: string | null;
    propertyId: string | null;
    propertyName: string | null;
    leadId: string | null;
    leadName: string | null;
    dealId: string | null;
    dealName: string | null;
    projectId: string | null;
    projectName: string | null;
    confidence: string;
    assignmentReason: string | null;
  } | null;
  preview: {
    affectedMessageCount: number;
    affectedMessageIds: string[];
    currentDealId: string | null;
    nextDealId: string | null;
  } | null;
  emails: Array<typeof emails.$inferSelect>;
}

export interface EmailThreadMutationContext {
  mailboxAccountId: string;
  binding: ThreadBindingRecord | null;
  emails: Array<typeof emails.$inferSelect>;
}

type EmailAssignmentUpdate = {
  assignedEntityType: EmailAssignmentEntityType | null;
  assignedEntityId: string | null;
  assignmentConfidence: EmailAssignmentResult["confidence"];
  assignmentAmbiguityReason: string | null;
  dealId: string | null;
};

function assignmentUpdateForDeal(dealId: string): EmailAssignmentUpdate {
  return {
    assignedEntityType: "deal",
    assignedEntityId: dealId,
    assignmentConfidence: "high",
    assignmentAmbiguityReason: null,
    dealId,
  };
}

function normalizeEmailSubject(subject: string): string {
  return subject
    .replace(/^(re|fw|fwd):\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildParticipantFingerprint(to: string[], cc: string[]): string {
  return [...to, ...cc]
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
}

export async function resolveMailboxAccountIdForCrmUser(
  tenantDb: TenantDb,
  crmUserId: string
): Promise<string> {
  const [tokenRow] = await tenantDb
    .select({ id: userGraphTokens.id })
    .from(userGraphTokens)
    .where(and(eq(userGraphTokens.userId, crmUserId), eq(userGraphTokens.status, "active")))
    .limit(1);

  if (!tokenRow) {
    throw new AppError(409, "Connect mailbox first");
  }

  return tokenRow.id;
}

export async function getThreadAssignment(
  tenantDb: TenantDb,
  mailboxAccountId: string,
  conversationId: string | null | undefined
): Promise<EmailAssignmentThreadAssignment | null> {
  if (!conversationId) return null;

  const activeBinding = await getActiveThreadBinding(tenantDb, mailboxAccountId, conversationId);
  if (activeBinding?.dealId) {
    return {
      assignedEntityType: "deal",
      assignedEntityId: activeBinding.dealId,
      assignedDealId: activeBinding.dealId,
    };
  }

  const mailboxUserId = await resolveMailboxUserId(tenantDb, mailboxAccountId);
  const fallbackWhere = buildThreadAssignmentFallbackWhereClause(mailboxUserId, conversationId);
  const [row] = await tenantDb
    .select({
      assignedEntityType: emails.assignedEntityType,
      assignedEntityId: emails.assignedEntityId,
      dealId: emails.dealId,
    })
    .from(emails)
    .where(fallbackWhere)
    .orderBy(desc(emails.sentAt))
    .limit(1);

  if (!row) return null;

  if (row.assignedEntityType === "deal" && row.assignedEntityId) {
    return {
      assignedEntityType: "deal",
      assignedEntityId: row.assignedEntityId,
      assignedDealId: row.dealId ?? row.assignedEntityId,
    };
  }

  if (
    (row.assignedEntityType === "company" ||
      row.assignedEntityType === "property" ||
      row.assignedEntityType === "lead") &&
    row.assignedEntityId
  ) {
    return {
      assignedEntityType: row.assignedEntityType,
      assignedEntityId: row.assignedEntityId,
      assignedDealId: null,
    };
  }

  if (row.dealId) {
    return {
      assignedEntityType: "deal",
      assignedEntityId: row.dealId,
      assignedDealId: row.dealId,
    };
  }

  return null;
}

export function buildThreadAssignmentFallbackWhereClause(
  mailboxUserId: string,
  conversationId: string
) {
  return and(
    eq(emails.userId, mailboxUserId),
    eq(emails.graphConversationId, conversationId),
    or(
      sql`${emails.assignedEntityType} IS NOT NULL`,
      sql`${emails.dealId} IS NOT NULL`
    )
  );
}

async function getEmailCandidateDeals(
  tenantDb: TenantDb,
  contactId: string | null | undefined
): Promise<{
  companyId: string | null;
  companyName: string | null;
  dealCandidates: EmailAssignmentDealCandidate[];
  leadCandidates: EmailAssignmentLeadCandidate[];
  propertyCandidates: ReturnType<typeof buildPropertyCandidatesFromDeals>;
}> {
  if (!contactId) {
    return {
      companyId: null,
      companyName: null,
      dealCandidates: [],
      leadCandidates: [],
      propertyCandidates: [],
    };
  }

  const [estimatingStageRow] = await tenantDb
    .select({ displayOrder: pipelineStageConfig.displayOrder })
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.slug, "estimating"))
    .limit(1);
  const estimatingStageDisplayOrder = estimatingStageRow?.displayOrder ?? 2;

  const [contactRow] = await tenantDb
    .select({
      companyId: contacts.companyId,
      companyName: contacts.companyName,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const companyId = contactRow?.companyId ?? null;
  const companyName = contactRow?.companyName ?? null;

  const contactDeals = await tenantDb
    .select({
      id: deals.id,
      dealNumber: deals.dealNumber,
      name: deals.name,
      companyId: deals.companyId,
      stageSlug: pipelineStageConfig.slug,
      stageDisplayOrder: pipelineStageConfig.displayOrder,
      propertyAddress: deals.propertyAddress,
      propertyCity: deals.propertyCity,
      propertyState: deals.propertyState,
      propertyZip: deals.propertyZip,
    })
    .from(deals)
    .innerJoin(contactDealAssociations, eq(contactDealAssociations.dealId, deals.id))
    .innerJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(and(eq(contactDealAssociations.contactId, contactId), eq(deals.isActive, true)));

  const companyDeals =
    companyId == null
      ? []
      : await tenantDb
          .select({
            id: deals.id,
            dealNumber: deals.dealNumber,
            name: deals.name,
            companyId: deals.companyId,
            stageSlug: pipelineStageConfig.slug,
            stageDisplayOrder: pipelineStageConfig.displayOrder,
            propertyAddress: deals.propertyAddress,
            propertyCity: deals.propertyCity,
            propertyState: deals.propertyState,
            propertyZip: deals.propertyZip,
          })
          .from(deals)
          .innerJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
          .where(and(eq(deals.companyId, companyId), eq(deals.isActive, true)));

  const candidateDeals = [...contactDeals, ...companyDeals].reduce<EmailAssignmentDealCandidate[]>(
    (acc, deal) => {
      if (acc.some((existing) => existing.id === deal.id)) return acc;
      acc.push(deal);
      return acc;
    },
    []
  );

  return {
    companyId,
    companyName,
    dealCandidates: candidateDeals,
    leadCandidates: buildLeadCandidatesFromDeals(candidateDeals, estimatingStageDisplayOrder),
    propertyCandidates: buildPropertyCandidatesFromDeals(candidateDeals),
  };
}

export async function getActiveThreadBinding(
  tenantDb: TenantDb,
  mailboxAccountId: string,
  providerConversationId: string
): Promise<ThreadBindingRecord | null> {
  const [binding] = await tenantDb
    .select()
    .from(emailThreadBindings)
    .where(
      and(
        eq(emailThreadBindings.mailboxAccountId, mailboxAccountId),
        eq(emailThreadBindings.provider, "microsoft_graph"),
        eq(emailThreadBindings.providerConversationId, providerConversationId),
        sql`${emailThreadBindings.detachedAt} IS NULL`
      )
    )
    .limit(1);
  return binding ?? null;
}

async function getProvisionalThreadBinding(
  tenantDb: TenantDb,
  mailboxAccountId: string,
  normalizedSubject: string,
  participantFingerprint: string
): Promise<ThreadBindingRecord | null> {
  const [binding] = await tenantDb
    .select()
    .from(emailThreadBindings)
    .where(
      and(
        eq(emailThreadBindings.mailboxAccountId, mailboxAccountId),
        eq(emailThreadBindings.provider, "microsoft_graph"),
        eq(emailThreadBindings.normalizedSubject, normalizedSubject),
        eq(emailThreadBindings.participantFingerprint, participantFingerprint),
        sql`${emailThreadBindings.providerConversationId} IS NULL`,
        sql`${emailThreadBindings.detachedAt} IS NULL`,
        sql`${emailThreadBindings.provisionalUntil} IS NOT NULL AND ${emailThreadBindings.provisionalUntil} > now()`
      )
    )
    .limit(1);
  return binding ?? null;
}

async function resolveMailboxUserId(
  tenantDb: TenantDb,
  mailboxAccountId: string
): Promise<string> {
  const [tokenRow] = await tenantDb
    .select({ userId: userGraphTokens.userId })
    .from(userGraphTokens)
    .where(eq(userGraphTokens.id, mailboxAccountId))
    .limit(1);

  if (!tokenRow) {
    throw new AppError(404, "Mailbox not found");
  }

  return tokenRow.userId;
}

export async function getEmailThreadForMutation(
  tenantDb: TenantDb,
  providerConversationId: string
): Promise<EmailThreadMutationContext> {
  const threadEmails = await tenantDb
    .select()
    .from(emails)
    .where(eq(emails.graphConversationId, providerConversationId))
    .orderBy(sql`${emails.sentAt} ASC`);

  if (threadEmails.length === 0) {
    throw new AppError(404, "Email thread not found");
  }

  const mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, threadEmails[0].userId);
  const binding = await getActiveThreadBinding(tenantDb, mailboxAccountId, providerConversationId);

  return {
    mailboxAccountId,
    binding,
    emails: threadEmails,
  };
}

export async function assertCanMutateEmailThread(
  tenantDb: TenantDb,
  thread: EmailThreadMutationContext,
  user: { id: string; role: string }
) {
  if (user.role === "admin" || user.role === "director") {
    return;
  }

  const mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, user.id);
  if (thread.mailboxAccountId !== mailboxAccountId) {
    throw new AppError(403, "You can only modify your own email threads");
  }
}

export async function previewThreadReassignmentImpact(
  tenantDb: TenantDb,
  input: {
    mailboxAccountId: string;
    providerConversationId: string;
    nextDealId: string;
  }
) {
  const mailboxUserId = await resolveMailboxUserId(tenantDb, input.mailboxAccountId);
  const messageRows = await tenantDb
    .select({ id: emails.id, dealId: emails.dealId })
    .from(emails)
    .where(
      and(
        eq(emails.userId, mailboxUserId),
        eq(emails.graphConversationId, input.providerConversationId)
      )
    );

  return {
    affectedMessageCount: messageRows.length,
    affectedMessageIds: messageRows.map((row) => row.id),
    currentDealId: messageRows[0]?.dealId ?? null,
    nextDealId: input.nextDealId,
  };
}

export async function detachThreadByConversation(
  tenantDb: TenantDb,
  mailboxAccountId: string,
  providerConversationId: string,
  actingUserId: string
) {
  await tenantDb
    .update(emailThreadBindings)
    .set({
      detachedAt: new Date(),
      updatedBy: actingUserId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailThreadBindings.mailboxAccountId, mailboxAccountId),
        eq(emailThreadBindings.provider, "microsoft_graph"),
        eq(emailThreadBindings.providerConversationId, providerConversationId),
        sql`${emailThreadBindings.detachedAt} IS NULL`
      )
    );
}

async function backAssociateStoredMessagesForBinding(
  tenantDb: TenantDb,
  input: {
    mailboxAccountId: string;
    providerConversationId: string;
    bindingId: string;
    dealId: string;
    actingUserId: string;
  }
) {
  const mailboxUserId = await resolveMailboxUserId(tenantDb, input.mailboxAccountId);
  await tenantDb
    .update(emails)
    .set({
      dealId: input.dealId,
      assignedEntityType: "deal",
      assignedEntityId: input.dealId,
      assignmentConfidence: "high",
      assignmentAmbiguityReason: null,
      threadBindingId: input.bindingId,
    })
    .where(
      and(
        eq(emails.userId, mailboxUserId),
        eq(emails.graphConversationId, input.providerConversationId),
        or(
          sql`${emails.threadBindingId} IS NULL`,
          eq(emails.threadBindingId, input.bindingId)
        )
      )
    );
}

export async function bindThreadToDeal(
  tenantDb: TenantDb,
  input: {
    mailboxAccountId: string;
    providerConversationId: string;
    dealId: string;
    actingUserId: string;
  }
): Promise<{ binding: ThreadBindingRecord; previousBindingId: string | null }> {
  const existing = await getActiveThreadBinding(tenantDb, input.mailboxAccountId, input.providerConversationId);

  if (existing?.dealId === input.dealId) {
    return { binding: existing, previousBindingId: null };
  }

  if (existing) {
    await tenantDb
      .update(emailThreadBindings)
      .set({
        detachedAt: new Date(),
        updatedBy: input.actingUserId,
        updatedAt: new Date(),
      })
      .where(eq(emailThreadBindings.id, existing.id));
  }

  const [binding] = await tenantDb
    .insert(emailThreadBindings)
    .values({
      mailboxAccountId: input.mailboxAccountId,
      provider: "microsoft_graph",
      providerConversationId: input.providerConversationId,
      dealId: input.dealId,
      bindingSource: "manual",
      confidence: "high",
      assignmentReason: "manual_thread_assignment",
      createdBy: input.actingUserId,
      updatedBy: input.actingUserId,
    })
    .returning();

  await backAssociateStoredMessagesForBinding(tenantDb, {
    mailboxAccountId: input.mailboxAccountId,
    providerConversationId: input.providerConversationId,
    bindingId: binding.id,
    dealId: input.dealId,
    actingUserId: input.actingUserId,
  });

  return { binding, previousBindingId: existing?.id ?? null };
}

export async function seedOutboundThreadBinding(
  tenantDb: TenantDb,
  input: {
    mailboxAccountId: string;
    provider: "microsoft_graph";
    providerConversationId?: string | null;
    normalizedSubject: string;
    participantFingerprint: string;
    dealId: string;
    actingUserId: string;
  }
): Promise<ThreadBindingRecord> {
  if (input.providerConversationId) {
    const result = await bindThreadToDeal(tenantDb, {
      mailboxAccountId: input.mailboxAccountId,
      providerConversationId: input.providerConversationId,
      dealId: input.dealId,
      actingUserId: input.actingUserId,
    });
    return result.binding;
  }

  const existing = await getProvisionalThreadBinding(
    tenantDb,
    input.mailboxAccountId,
    input.normalizedSubject,
    input.participantFingerprint
  );
  if (existing) return existing;

  const [binding] = await tenantDb
    .insert(emailThreadBindings)
    .values({
      mailboxAccountId: input.mailboxAccountId,
      provider: input.provider,
      normalizedSubject: input.normalizedSubject,
      participantFingerprint: input.participantFingerprint,
      dealId: input.dealId,
      bindingSource: "outbound_seed",
      confidence: "high",
      assignmentReason: "outbound_thread_seed",
      provisionalUntil: sql`now() + interval '24 hours'`,
      createdBy: input.actingUserId,
      updatedBy: input.actingUserId,
    })
    .returning();

  return binding;
}

export async function getEmailAssignmentQueue(
  tenantDb: TenantDb,
  filters: EmailAssignmentQueueFilters = {},
  userId?: string,
  userRole?: string
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 25;
  const offset = (page - 1) * limit;

  const conditions: any[] = [
    eq(emails.direction, "inbound"),
    sql`${emails.assignmentAmbiguityReason} IS NOT NULL`,
  ];

  if (userId && userRole === "rep") {
    conditions.push(eq(emails.userId, userId));
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

  const items = await Promise.all(
    emailRows.filter(isEmailAssignmentQueueCandidate).map(async (emailRow) => {
      const [contactRow] = emailRow.contactId
        ? await tenantDb
            .select({
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              companyId: contacts.companyId,
              companyName: contacts.companyName,
            })
            .from(contacts)
            .where(eq(contacts.id, emailRow.contactId))
            .limit(1)
        : [null];

      const { companyId, companyName, dealCandidates, leadCandidates, propertyCandidates } = await getEmailCandidateDeals(
        tenantDb,
        emailRow.contactId
      );
      const mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, emailRow.userId);
      const suggestedAssignment = resolveEmailAssignment({
        subject: emailRow.subject,
        bodyPreview: emailRow.bodyPreview,
        bodyHtml: emailRow.bodyHtml,
        priorThreadAssignment: await getThreadAssignment(tenantDb, mailboxAccountId, emailRow.graphConversationId),
        contactCompanyId: contactRow?.companyId ?? companyId,
        dealCandidates,
        leadCandidates,
        propertyCandidates,
      });

      return {
        email: emailRow,
        companyId: contactRow?.companyId ?? companyId,
        contactName: contactRow ? `${contactRow.firstName} ${contactRow.lastName}`.trim() : null,
        companyName: contactRow?.companyName ?? companyName,
        candidateDeals: dealCandidates,
        candidateLeads: leadCandidates,
        candidateProperties: propertyCandidates,
        suggestedAssignment,
      } satisfies EmailAssignmentQueueItem;
    })
  );

  return {
    items,
    pagination: {
      page,
      limit,
      total: Number(countResult[0]?.count ?? 0),
      totalPages: Math.ceil(Number(countResult[0]?.count ?? 0) / limit),
    },
  };
}

/**
 * Send an email via MS Graph API and log it in the emails table.
 */
export async function sendEmail(
  tenantDb: TenantDb,
  userId: string,
  input: SendEmailInput
): Promise<any> {
  let outboundAssignment: EmailAssignmentUpdate = {
    assignedEntityType: null,
    assignedEntityId: null,
    assignmentConfidence: "low",
    assignmentAmbiguityReason: null,
    dealId: null,
  };
  if (input.dealId) {
    outboundAssignment = assignmentUpdateForDeal(input.dealId);
  } else if (input.contactId) {
    const [contactRow] = await tenantDb
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .limit(1);
    if (contactRow?.companyId) {
      outboundAssignment = {
        assignedEntityType: "company",
        assignedEntityId: contactRow.companyId,
        assignmentConfidence: "medium",
        assignmentAmbiguityReason: null,
        dealId: null,
      };
    }
  }

  const activitySourceEntityType =
    input.dealId ? "deal" : outboundAssignment.assignedEntityType === "company" ? "company" : "contact";
  const activitySourceEntityId =
    input.dealId ?? outboundAssignment.assignedEntityId ?? input.contactId ?? null;
  if (!activitySourceEntityId) {
    throw new AppError(400, "Outbound email must be associated to a deal, company, or contact.");
  }

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
      ...outboundAssignment,
      userId,
      sentAt: new Date(),
    })
    .returning();

  if (input.dealId) {
    const mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, userId);
    const binding = await seedOutboundThreadBinding(tenantDb, {
      mailboxAccountId,
      provider: "microsoft_graph",
      providerConversationId: graphConversationId,
      normalizedSubject: normalizeEmailSubject(input.subject),
      participantFingerprint: buildParticipantFingerprint(input.to, input.cc ?? []),
      dealId: input.dealId,
      actingUserId: userId,
    });

    await tenantDb
      .update(emails)
      .set({ threadBindingId: binding.id })
      .where(eq(emails.id, emailRecord.id));

    emailRecord.threadBindingId = binding.id;
  }

  // Create activity record for the unified feed
  await tenantDb.insert(activities).values({
    type: "email",
    responsibleUserId: userId,
    performedByUserId: userId,
    sourceEntityType: activitySourceEntityType,
    sourceEntityId: activitySourceEntityId,
    companyId: outboundAssignment.assignedEntityType === "company" ? outboundAssignment.assignedEntityId : null,
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
  let outboundAssignment: EmailAssignmentUpdate = {
    assignedEntityType: null,
    assignedEntityId: null,
    assignmentConfidence: "low",
    assignmentAmbiguityReason: null,
    dealId: null,
  };
  if (input.dealId) {
    outboundAssignment = assignmentUpdateForDeal(input.dealId);
  } else if (input.contactId) {
    const [contactRow] = await tenantDb
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .limit(1);
    if (contactRow?.companyId) {
      outboundAssignment = {
        assignedEntityType: "company",
        assignedEntityId: contactRow.companyId,
        assignmentConfidence: "medium",
        assignmentAmbiguityReason: null,
        dealId: null,
      };
    }
  }

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
      ...outboundAssignment,
      userId,
      sentAt: new Date(),
    })
    .returning();

  if (input.dealId) {
    const mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, userId);
    const binding = await seedOutboundThreadBinding(tenantDb, {
      mailboxAccountId,
      provider: "microsoft_graph",
      providerConversationId: null,
      normalizedSubject: normalizeEmailSubject(input.subject),
      participantFingerprint: buildParticipantFingerprint(input.to, input.cc ?? []),
      dealId: input.dealId,
      actingUserId: userId,
    });

    await tenantDb
      .update(emails)
      .set({ threadBindingId: binding.id })
      .where(eq(emails.id, emailRecord.id));

    emailRecord.threadBindingId = binding.id;
  }

  const activitySourceEntityType =
    input.dealId ? "deal" : outboundAssignment.assignedEntityType === "company" ? "company" : "contact";
  const activitySourceEntityId =
    input.dealId ?? outboundAssignment.assignedEntityId ?? input.contactId ?? null;
  if (!activitySourceEntityId) {
    throw new AppError(400, "Outbound email must be associated to a deal, company, or contact.");
  }
  await tenantDb.insert(activities).values({
    type: "email",
    responsibleUserId: userId,
    performedByUserId: userId,
    sourceEntityType: activitySourceEntityType,
    sourceEntityId: activitySourceEntityId,
    companyId: outboundAssignment.assignedEntityType === "company" ? outboundAssignment.assignedEntityId : null,
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
) : Promise<EmailThreadResponse> {
  if (!conversationId) return { binding: null, preview: null, emails: [] };

  const conditions: any[] = [eq(emails.graphConversationId, conversationId)];

  // RBAC: reps can only see their own emails in the thread
  if (userId && userRole === "rep") {
    conditions.push(eq(emails.userId, userId));
  }

  // Thread view: chronological order (oldest first) for natural reading context
  const thread = await tenantDb
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(sql`${emails.sentAt} ASC`);

  if (thread.length === 0) {
    return { binding: null, preview: null, emails: [] };
  }

  const mutationContext = await getEmailThreadForMutation(tenantDb, conversationId);

  let bindingPayload: EmailThreadResponse["binding"] = null;
  if (mutationContext.binding) {
    const [dealRow] = mutationContext.binding.dealId
      ? await tenantDb
          .select({ id: deals.id, name: deals.name })
          .from(deals)
          .where(eq(deals.id, mutationContext.binding.dealId))
          .limit(1)
      : [null];
    bindingPayload = {
      id: mutationContext.binding.id,
      mailboxAccountId: mutationContext.binding.mailboxAccountId,
      contactId: thread[0]?.contactId ?? null,
      contactName: null,
      companyId: null,
      companyName: null,
      propertyId: null,
      propertyName: null,
      leadId: null,
      leadName: null,
      dealId: mutationContext.binding.dealId ?? null,
      dealName: dealRow?.name ?? null,
      projectId: mutationContext.binding.projectId ?? null,
      projectName: null,
      confidence: mutationContext.binding.confidence,
      assignmentReason: mutationContext.binding.assignmentReason ?? null,
    };
  }

  return {
    binding: bindingPayload,
    preview: null,
    emails: thread,
  };
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
async function completeInboundEmailTasks(
  tenantDb: TenantDb,
  emailId: string,
  userRole: string,
  userId: string,
  officeId: string
): Promise<void> {
  const openTasks = await tenantDb
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.emailId, emailId),
        eq(tasks.type, "inbound_email")
      )
    );

  for (const taskRow of openTasks as Array<any>) {
    if (taskRow.status === "completed" || taskRow.status === "dismissed") continue;
    const completedTask = await completeTask(tenantDb, taskRow.id, userRole, userId);
    const completionRule = completedTask.originRule
      ? TASK_RULES.find((rule) => rule.id === completedTask.originRule)
      : null;

    if (completedTask.originRule && !completionRule) {
      throw new AppError(500, `Missing rule configuration for completed task originRule ${completedTask.originRule}`);
    }

    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "task.completed",
        taskId: completedTask.id,
        dealId: completedTask.dealId,
        contactId: completedTask.contactId,
        title: completedTask.title,
        type: completedTask.type,
        completedBy: userId,
        originRule: completedTask.originRule,
        dedupeKey: completedTask.dedupeKey,
        reasonCode: completedTask.reasonCode,
        entitySnapshot: completedTask.entitySnapshot,
        suppressionWindowDays: completionRule?.suppressionWindowDays ?? null,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    });
  }
}

export async function associateEmailToEntity(
  tenantDb: TenantDb,
  emailId: string,
  input: {
    assignedEntityType: "deal" | "company" | "property" | "lead";
    assignedEntityId: string;
    assignedDealId?: string | null;
  },
  userRole: string,
  userId: string,
  officeId: string
): Promise<void> {
  const email = await getEmailById(tenantDb, emailId);
  if (!email) throw new AppError(404, "Email not found");

  if (!["deal", "company", "property", "lead"].includes(input.assignedEntityType)) {
    throw new AppError(400, "Unsupported assignment target");
  }

  const assignedDealId = input.assignedEntityType === "deal" ? input.assignedDealId ?? input.assignedEntityId : null;
  if (input.assignedEntityType === "deal" && assignedDealId !== input.assignedEntityId) {
    throw new AppError(400, "assignedDealId must match assignedEntityId for deal assignments");
  }

  let assignmentLinks: {
    sourceEntityType: "company" | "property" | "lead" | "deal";
    sourceEntityId: string;
    companyId: string | null;
    propertyId: string | null;
    leadId: string | null;
    dealId: string | null;
  };

  if (input.assignedEntityType === "deal") {
    const [deal] = await tenantDb
      .select({
        id: deals.id,
        companyId: deals.companyId,
        propertyId: deals.propertyId,
        sourceLeadId: deals.sourceLeadId,
      })
      .from(deals)
      .where(eq(deals.id, input.assignedEntityId))
      .limit(1);
    if (!deal) throw new AppError(404, "Deal not found");

    assignmentLinks = {
      sourceEntityType: "deal",
      sourceEntityId: input.assignedEntityId,
      companyId: deal.companyId ?? null,
      propertyId: deal.propertyId ?? null,
      leadId: deal.sourceLeadId ?? null,
      dealId: assignedDealId,
    };
  } else if (input.assignedEntityType === "company") {
    const [company] = await tenantDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.assignedEntityId))
      .limit(1);
    if (!company) throw new AppError(404, "Company not found");

    assignmentLinks = {
      sourceEntityType: "company",
      sourceEntityId: input.assignedEntityId,
      companyId: input.assignedEntityId,
      propertyId: null,
      leadId: null,
      dealId: null,
    };
  } else if (input.assignedEntityType === "property") {
    const [property] = await tenantDb
      .select({ id: properties.id, companyId: properties.companyId })
      .from(properties)
      .where(eq(properties.id, input.assignedEntityId))
      .limit(1);
    if (!property) throw new AppError(404, "Property not found");

    assignmentLinks = {
      sourceEntityType: "property",
      sourceEntityId: input.assignedEntityId,
      companyId: property.companyId ?? null,
      propertyId: input.assignedEntityId,
      leadId: null,
      dealId: null,
    };
  } else {
    const [lead] = await tenantDb
      .select({ id: leads.id, companyId: leads.companyId, propertyId: leads.propertyId })
      .from(leads)
      .where(eq(leads.id, input.assignedEntityId))
      .limit(1);
    if (!lead) throw new AppError(404, "Lead not found");

    assignmentLinks = {
      sourceEntityType: "lead",
      sourceEntityId: input.assignedEntityId,
      companyId: lead.companyId ?? null,
      propertyId: lead.propertyId ?? null,
      leadId: input.assignedEntityId,
      dealId: null,
    };
  }

  await tenantDb
    .update(emails)
    .set({
      assignedEntityType: input.assignedEntityType,
      assignedEntityId: input.assignedEntityId,
      assignmentConfidence: "high",
      assignmentAmbiguityReason: null,
      dealId: assignedDealId,
    })
    .where(eq(emails.id, emailId));

  const updatedActivities = await tenantDb
    .update(activities)
    .set({
      sourceEntityType: assignmentLinks.sourceEntityType,
      sourceEntityId: assignmentLinks.sourceEntityId,
      companyId: assignmentLinks.companyId,
      propertyId: assignmentLinks.propertyId,
      leadId: assignmentLinks.leadId,
      dealId: assignmentLinks.dealId,
    })
    .where(eq(activities.emailId, emailId))
    .returning({ id: activities.id });

  if (updatedActivities.length === 0) {
    await tenantDb.insert(activities).values({
      type: "email",
      responsibleUserId: email.userId,
      performedByUserId: email.userId,
      sourceEntityType: assignmentLinks.sourceEntityType,
      sourceEntityId: assignmentLinks.sourceEntityId,
      companyId: assignmentLinks.companyId,
      propertyId: assignmentLinks.propertyId,
      leadId: assignmentLinks.leadId,
      dealId: assignmentLinks.dealId,
      contactId: email.contactId ?? null,
      emailId: email.id,
      subject: email.subject ?? null,
      body: email.bodyPreview ?? (email.bodyHtml ? stripHtml(email.bodyHtml).substring(0, 1000) : null),
      occurredAt: email.sentAt,
    });
  }

  await completeInboundEmailTasks(tenantDb, emailId, userRole, userId, officeId);
}

export async function associateEmailToDeal(
  tenantDb: TenantDb,
  emailId: string,
  dealId: string
): Promise<void> {
  await tenantDb
    .update(emails)
    .set(assignmentUpdateForDeal(dealId))
    .where(eq(emails.id, emailId));

  await tenantDb
    .update(activities)
    .set({ dealId })
    .where(eq(activities.emailId, emailId));

  await tenantDb
    .update(tasks)
    .set({
      dealId,
      status: "completed",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
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
