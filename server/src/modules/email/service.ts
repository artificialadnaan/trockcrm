import { eq, and, desc, sql, or, inArray, isNull } from "drizzle-orm";
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
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { graphRequest } from "../../lib/graph-client.js";
import { getValidAccessToken, isGraphAuthConfigured } from "./graph-auth.js";
import { composeBodyWithSignature } from "./signature-compose.js";
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
import {
  collectEmailStatTargetsForEmail,
  refreshEmailStatsForEmailRecord,
  refreshEmailStatsForTargets,
} from "./stats-service.js";
import { assertDealCollaboratorAccess } from "../../lib/collaboration-access.js";
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
  assignedEntityType?: "deal" | "company" | "lead" | "contact" | "property" | null;
  assignedEntityId?: string | null;
  assignedDealId?: string | null;
}

export interface EmailFilters {
  companyId?: string;
  dealId?: string;
  leadId?: string;
  contactId?: string;
  direction?: "inbound" | "outbound";
  filter?: "all" | "unread" | "unassigned" | "sent";
  status?: "unassigned" | "assigned" | "ignored" | "deleted";
  search?: string;
  page?: number;
  limit?: number;
}

export interface EmailInboxActionInput {
  isStarred?: boolean;
  archived?: boolean;
  deleted?: boolean;
}

export interface EmailAssignmentQueueFilters {
  search?: string;
  status?: "unassigned" | "ignored";
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

// Directions that can sit in the ASSIGNMENT QUEUE (the surface a rep uses to assign mail to a deal). Sent
// emails captured from Outlook can land here too — a rep's sent-to-a-known-contact email whose recipient
// maps to 0 or multiple deals needs manual assignment, same as an inbound one. SINGLE source of truth for
// the TWO queue sites only — the SQL queue predicate (getEmailAssignmentQueue) and the JS candidate check
// (isEmailAssignmentQueueCandidate) — so a sent email counted by the queue also survives the JS filter
// (count == items). It deliberately does NOT touch the inbox unread/unassigned predicate, which stays
// inbound-only so Sent mail never shows as "unread".
const ASSIGNABLE_DIRECTIONS = ["inbound", "outbound"] as const;

export function isEmailAssignmentQueueCandidate(emailRow: {
  direction: "inbound" | "outbound";
  assignmentAmbiguityReason: string | null;
  assignmentStatus?: string | null;
}) {
  return (
    (ASSIGNABLE_DIRECTIONS as readonly string[]).includes(emailRow.direction) &&
    emailRow.assignmentAmbiguityReason != null &&
    (emailRow.assignmentStatus ?? "unassigned") === "unassigned"
  );
}

// INBOX "unread/unassigned" badge predicate — stays INBOUND-ONLY. The client's needs-attention/unread
// count is an inbox concept; a rep's own Sent mail must never show as "unread". The outbound relaxation
// for making sent mail assignable lives ONLY in the assignment-queue predicate (getEmailAssignmentQueue)
// and isEmailAssignmentQueueCandidate — NOT here.
function emailIsUnassignedCondition() {
  return and(
    eq(emails.direction, "inbound"),
    eq(emails.assignmentStatus, "unassigned"),
    isNull(emails.assignedEntityId),
    isNull(emails.dealId),
    isNull(emails.contactId)
  );
}

function applyInboxFilter(conditions: any[], filter: EmailFilters["filter"]) {
  if (!filter || filter === "all") return;
  if (filter === "sent") {
    conditions.push(eq(emails.direction, "outbound"));
    return;
  }
  if (filter === "unread" || filter === "unassigned") {
    conditions.push(emailIsUnassignedCondition());
  }
}

function activeEmailConditions() {
  return [isNull(emails.archivedAt), isNull(emails.deletedAt)];
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

type OutboundActivityLinks = {
  sourceEntityType: "deal" | "company" | "contact" | "lead" | "property";
  sourceEntityId: string;
  companyId: string | null;
  propertyId: string | null;
  leadId: string | null;
  dealId: string | null;
  contactId: string | null;
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

async function resolveOutboundAssociation(
  tenantDb: TenantDb,
  input: SendEmailInput
): Promise<{ assignment: EmailAssignmentUpdate; links: OutboundActivityLinks } | null> {
  if (input.assignedEntityType && input.assignedEntityId) {
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

      return {
        assignment: assignmentUpdateForDeal(input.assignedEntityId),
        links: {
          sourceEntityType: "deal",
          sourceEntityId: input.assignedEntityId,
          companyId: deal.companyId ?? null,
          propertyId: deal.propertyId ?? null,
          leadId: deal.sourceLeadId ?? null,
          dealId: input.assignedEntityId,
          contactId: null,
        },
      };
    }

    if (input.assignedEntityType === "company") {
      return {
        assignment: {
          assignedEntityType: "company",
          assignedEntityId: input.assignedEntityId,
          assignmentConfidence: "high",
          assignmentAmbiguityReason: null,
          dealId: null,
        },
        links: {
          sourceEntityType: "company",
          sourceEntityId: input.assignedEntityId,
          companyId: input.assignedEntityId,
          propertyId: null,
          leadId: null,
          dealId: null,
          contactId: null,
        },
      };
    }

    if (input.assignedEntityType === "contact") {
      const [contact] = await tenantDb
        .select({ id: contacts.id, companyId: contacts.companyId })
        .from(contacts)
        .where(eq(contacts.id, input.assignedEntityId))
        .limit(1);
      if (!contact) throw new AppError(404, "Contact not found");

      return {
        assignment: {
          assignedEntityType: "contact",
          assignedEntityId: input.assignedEntityId,
          assignmentConfidence: "high",
          assignmentAmbiguityReason: null,
          dealId: null,
        },
        links: {
          sourceEntityType: "contact",
          sourceEntityId: input.assignedEntityId,
          companyId: contact.companyId ?? null,
          propertyId: null,
          leadId: null,
          dealId: null,
          contactId: input.assignedEntityId,
        },
      };
    }

    if (input.assignedEntityType === "lead") {
      const [lead] = await tenantDb
        .select({ id: leads.id, companyId: leads.companyId, propertyId: leads.propertyId })
        .from(leads)
        .where(eq(leads.id, input.assignedEntityId))
        .limit(1);
      if (!lead) throw new AppError(404, "Lead not found");

      return {
        assignment: {
          assignedEntityType: "lead",
          assignedEntityId: input.assignedEntityId,
          assignmentConfidence: "high",
          assignmentAmbiguityReason: null,
          dealId: null,
        },
        links: {
          sourceEntityType: "lead",
          sourceEntityId: input.assignedEntityId,
          companyId: lead.companyId ?? null,
          propertyId: lead.propertyId ?? null,
          leadId: input.assignedEntityId,
          dealId: null,
          contactId: null,
        },
      };
    }
  }

  if (input.dealId) {
    const [deal] = await tenantDb
      .select({
        id: deals.id,
        companyId: deals.companyId,
        propertyId: deals.propertyId,
        sourceLeadId: deals.sourceLeadId,
      })
      .from(deals)
      .where(eq(deals.id, input.dealId))
      .limit(1);
    if (!deal) throw new AppError(404, "Deal not found");

    return {
      assignment: assignmentUpdateForDeal(input.dealId),
      links: {
        sourceEntityType: "deal",
        sourceEntityId: input.dealId,
        companyId: deal.companyId ?? null,
        propertyId: deal.propertyId ?? null,
        leadId: deal.sourceLeadId ?? null,
        dealId: input.dealId,
        contactId: null,
      },
    };
  }

  if (input.contactId) {
    const [contactRow] = await tenantDb
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .limit(1);
    if (contactRow?.companyId) {
      return {
        assignment: {
          assignedEntityType: "company",
          assignedEntityId: contactRow.companyId,
          assignmentConfidence: "medium",
          assignmentAmbiguityReason: null,
          dealId: null,
        },
        links: {
          sourceEntityType: "company",
          sourceEntityId: contactRow.companyId,
          companyId: contactRow.companyId,
          propertyId: null,
          leadId: null,
          dealId: null,
          contactId: input.contactId,
        },
      };
    }
  }

  return null;
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
    .select({
      displayOrder: sql<number>`MIN(${pipelineStageConfig.displayOrder})`,
    })
    .from(pipelineStageConfig)
    .where(inArray(pipelineStageConfig.slug, ["estimate_in_progress", "service_estimating"]))
    .limit(1);
  const estimatingStageDisplayOrder = Number(estimatingStageRow?.displayOrder ?? 3);

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

async function findAnyEmailInConversation(
  tenantDb: TenantDb,
  providerConversationId: string
): Promise<{ id: string; userId: string } | null> {
  const [email] = await tenantDb
    .select({ id: emails.id, userId: emails.userId })
    .from(emails)
    .where(eq(emails.graphConversationId, providerConversationId))
    .limit(1);

  return email ?? null;
}

/**
 * Does this conversation hold ANY message, in any mailbox?
 *
 * Exists so the thread READ route can tell "there is nothing here" apart from "you may not have it"
 * by ASKING, instead of by catching a 404 and guessing at its cause. Two unrelated things throw 404
 * behind that gate — getEmailThreadForMutation's "Email thread not found" and
 * assertDealCollaboratorAccess's "Deal not found" — so a status-keyed carve-out silently downgrades a
 * real authorization denial to a 200 that claims the thread is empty.
 */
export async function conversationHasAnyMessage(
  tenantDb: TenantDb,
  providerConversationId: string
): Promise<boolean> {
  return (await findAnyEmailInConversation(tenantDb, providerConversationId)) !== null;
}

/**
 * The thread a mutation is about to act on.
 *
 * `userId` scopes the thread to ONE mailbox's copy of the conversation. The deal-linkage mutation
 * routes deliberately pass NOTHING: scoping there would 403 a deal collaborator who owns none of the
 * messages before assertCanMutateEmailThread's deal-write path ever ran, which is the whole point of
 * that path. getEmailThread still passes it, because the thread READER is mailbox-scoped.
 *
 * Consequence to hold onto: unscoped, `mailboxAccountId` is ONE participant's mailbox out of however
 * many hold the conversation, and `binding` is that one mailbox's binding. Neither is a statement
 * about the conversation as a whole — for "what deal is this thread on", use
 * resolveActiveBindingDealIdForConversation, and for "which mailboxes hold it", use the
 * resolve*ForConversation helpers.
 */
export async function getEmailThreadForMutation(
  tenantDb: TenantDb,
  providerConversationId: string,
  userId?: string
): Promise<EmailThreadMutationContext> {
  const conditions: any[] = [eq(emails.graphConversationId, providerConversationId)];
  if (userId) {
    conditions.push(eq(emails.userId, userId));
  }
  // sent_at then id, matching the connected-mailbox lookup below so the two can never disagree about
  // which message is "oldest" when two share a timestamp.
  const threadEmails = await tenantDb
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(sql`${emails.sentAt} ASC`, sql`${emails.id} ASC`);

  // KNOWN GAP: a conversation whose messages have all been purged but whose binding survives 404s here,
  // before any gate runs, so it cannot be detached through these routes. Closing it means letting
  // mailboxAccountId be null and threading that through every consumer; the orphaned binding is
  // otherwise harmless (invisible in the UI, skipped by every rebind).
  if (threadEmails.length === 0) {
    if (userId) {
      const existingThreadEmail = await findAnyEmailInConversation(tenantDb, providerConversationId);
      if (existingThreadEmail) {
        throw new AppError(403, "You can only view and modify your own email threads");
      }
    }
    throw new AppError(404, "Email thread not found");
  }

  // The mailbox this thread is described BY.
  //
  // Scoped to a caller, every row already belongs to them, so the oldest message's owner IS the caller
  // and the direct lookup is exactly right — unchanged, 409 and all.
  //
  // UNSCOPED (the deal-linkage mutation routes), threadEmails[0] is whichever PARTICIPANT sent first,
  // and resolveMailboxAccountIdForCrmUser throws 409 "Connect mailbox first" for a user whose token row
  // was deleted (disconnect) or left non-active (a failed refresh). Handing it that user blind would
  // 409 the entire reassign/detach — for everyone — over some other participant's disconnected Outlook.
  // So take the oldest message whose owner is actually CONNECTED, falling back to the direct lookup
  // (and its 409) only when no participant is.
  let mailboxAccountId: string;
  if (userId) {
    mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, threadEmails[0].userId);
  } else {
    const [connectedMailbox] = await tenantDb
      .select({ id: userGraphTokens.id })
      .from(emails)
      .innerJoin(
        userGraphTokens,
        and(eq(userGraphTokens.userId, emails.userId), eq(userGraphTokens.status, "active"))
      )
      .where(eq(emails.graphConversationId, providerConversationId))
      .orderBy(sql`${emails.sentAt} ASC`, sql`${emails.id} ASC`)
      .limit(1);
    mailboxAccountId =
      connectedMailbox?.id ?? (await resolveMailboxAccountIdForCrmUser(tenantDb, threadEmails[0].userId));
  }
  const binding = await getActiveThreadBinding(tenantDb, mailboxAccountId, providerConversationId);

  return {
    mailboxAccountId,
    binding,
    emails: threadEmails,
  };
}

/**
 * May this user reach this email thread's deal linkage — to read it, or to change it?
 *
 * TWO accepted paths, checked in this order:
 *   1. MAILBOX OWNER — the thread is in the caller's own mailbox. Always allowed; a user can always
 *      fix the filing of their own email.
 *   2. DEAL WRITE ACCESS — the caller may write the deal the thread is currently bound to.
 *
 * Used by the thread READ route as well as the three mutation routes, and deliberately so: the
 * Reassign/Unassign controls are rendered from the read payload, so a stricter read gate makes the
 * mutations unreachable no matter how permissive they are. Path 2 resolves to
 * assertDealCollaboratorAccess, the same office-level predicate the deal Emails tab already uses to
 * decide what a user may see, so admitting a reader here grants nothing that tab does not.
 *
 * Path 2 is the point of this helper. The deal Emails LIST is NOT mailbox-scoped (getEmails is called
 * with no user filter), so a user routinely sees email from other mailboxes on a deal they own — the
 * misfiled email someone notices is frequently not their own, and owner-only would 403 exactly the
 * person who spotted it.
 *
 * An UNBOUND thread has no deal to authorize against, so only path 1 can admit it.
 *
 * `context.boundDealId` MUST be the deal the thread is CURRENTLY BOUND TO, never the deal it is being
 * moved to. Authorizing against the target would turn this into "anyone who can write the destination",
 * which is not a gate on the thread at all.
 *
 * This is the whole gate on the SOURCE thread — keep it as ONE helper with ONE set of tests, and do not
 * inline it into the routes. The TARGET deal is gated separately, by the routes' own
 * assertDealCollaboratorAccess call; that one is NOT redundant with this.
 */
export async function assertCanMutateEmailThread(
  tenantDb: TenantDb,
  thread: EmailThreadMutationContext,
  user: { id: string; role: string; officeId?: string | null; activeOfficeId?: string | null },
  context: { boundDealId: string | null }
) {
  // PATH 1 — mailbox owner: does the caller own a MESSAGE in this thread? emails.userId IS the mailbox
  // owner, and the routes hand this helper the WHOLE conversation, so this is the honest reading of
  // "the thread is in the caller's own mailbox".
  //
  // This deliberately replaces the old `thread.mailboxAccountId === resolveMailboxAccountIdForCrmUser(
  // user.id)` comparison rather than sitting alongside it. That comparison is not merely redundant now,
  // it is UNREACHABLE: thread.mailboxAccountId is always some conversation participant's own token id
  // (both branches of getEmailThreadForMutation derive it from a message owner), so it can only equal
  // the caller's token id when the caller owns a message — i.e. when the line above already returned.
  // It was also strictly NARROWER, admitting only whoever sent first on a thread that reached two
  // mailboxes. Removing it drops a per-gate SELECT and a 409-swallow that no longer guards anything: a
  // caller with no connected mailbox now simply misses path 1 by owning no message, with no query and
  // no exception involved.
  if (thread.emails.some((email) => email.userId === user.id)) return;

  // PATH 2 — deal write access.
  if (!context.boundDealId) {
    throw new AppError(403, "You can only modify your own email threads");
  }

  // Throws 403/404 itself when the caller cannot reach the deal.
  await assertDealCollaboratorAccess(tenantDb, context.boundDealId, user);
}

/**
 * Every mailbox account holding a MESSAGE from this conversation, restricted to mailboxes with an
 * active connection. The inner join to user_graph_tokens does that filtering inherently — a
 * participant with no connected mailbox simply has no row to join to, rather than needing a
 * per-user try/catch keyed off an HTTP status code. A binding is keyed on (mailbox_account_id,
 * provider, provider_conversation_id), so a conversation that reached two mailboxes has TWO
 * bindings — see bindConversationToDealAcrossMailboxes / detachConversationAcrossMailboxes below.
 */
export async function resolveMailboxAccountIdsForConversation(
  tenantDb: TenantDb,
  providerConversationId: string
): Promise<string[]> {
  const rows = await tenantDb
    .selectDistinct({ id: userGraphTokens.id })
    .from(emails)
    .innerJoin(
      userGraphTokens,
      and(eq(userGraphTokens.userId, emails.userId), eq(userGraphTokens.status, "active"))
    )
    .where(eq(emails.graphConversationId, providerConversationId));

  return rows.map((row) => row.id);
}

/**
 * Every mailbox account with a currently-ACTIVE binding for this conversation. A binding can outlive
 * every message it once covered (e.g. the messages were purged or never fully synced), so this is
 * NOT redundant with resolveMailboxAccountIdsForConversation above — bind and detach both need the
 * union of the two sets, or they'd disagree about what "every mailbox holding it" means.
 *
 * The join to user_graph_tokens is here for a different reason than the message-side query's: a
 * disconnect (POST /api/auth/graph/disconnect, graph-token-service.ts) hard-DELETEs the token row but
 * leaves email_thread_bindings untouched (mailbox_account_id carries no FK, and nothing else cleans
 * bindings up), so a binding can point at a mailbox whose token row is simply GONE. Handing that id to
 * bindThreadToDeal throws "Mailbox not found" and aborts the whole rebind — every mailbox, not just the
 * orphan. The join filters that dead-token case out. It deliberately does NOT filter on status, unlike
 * the message-side query: a token that's merely revoked/error still resolves fine through
 * resolveMailboxUserId (which looks up by id with no status filter), and that binding SHOULD still be
 * rebound or it strands — only a missing row is unhandleable.
 */
async function resolveMailboxAccountIdsWithActiveBindingForConversation(
  tenantDb: TenantDb,
  providerConversationId: string
): Promise<string[]> {
  const rows = await tenantDb
    .selectDistinct({ mailboxAccountId: emailThreadBindings.mailboxAccountId })
    .from(emailThreadBindings)
    .innerJoin(userGraphTokens, eq(userGraphTokens.id, emailThreadBindings.mailboxAccountId))
    .where(
      and(
        eq(emailThreadBindings.provider, "microsoft_graph"),
        eq(emailThreadBindings.providerConversationId, providerConversationId),
        sql`${emailThreadBindings.detachedAt} IS NULL`
      )
    );
  return rows.map((row) => row.mailboxAccountId);
}

/**
 * Rebind the conversation to `dealId` in every mailbox that holds it (by message or by an existing
 * active binding). Partial-failure safety across the sequential per-mailbox binds below comes from
 * the per-request tenant transaction (middleware/tenant.ts) wrapping the whole request — a caller
 * outside that context (a worker, a script) must open its own transaction.
 */
export async function bindConversationToDealAcrossMailboxes(
  tenantDb: TenantDb,
  input: { providerConversationId: string; dealId: string; actingUserId: string }
): Promise<void> {
  const messageMailboxIds = await resolveMailboxAccountIdsForConversation(
    tenantDb,
    input.providerConversationId
  );
  const boundMailboxIds = await resolveMailboxAccountIdsWithActiveBindingForConversation(
    tenantDb,
    input.providerConversationId
  );
  const mailboxAccountIds = Array.from(new Set([...messageMailboxIds, ...boundMailboxIds]));

  // bindThreadToDeal does a real per-mailbox read (getActiveThreadBinding) then write, so each mailbox
  // has to go sequentially rather than fan out in a Promise.all.
  for (const mailboxAccountId of mailboxAccountIds) {
    await bindThreadToDeal(tenantDb, {
      mailboxAccountId,
      providerConversationId: input.providerConversationId,
      dealId: input.dealId,
      actingUserId: input.actingUserId,
    });
  }
}

/**
 * Detach every active binding for this conversation in one statement — deliberately NOT scoped to a
 * mailbox derived from `emails`, so a binding whose mailbox has no surviving message rows is still
 * caught. Atomic by construction (a single UPDATE), so partial-failure safety here doesn't depend on
 * the caller's transaction the way the sequential binds above do; it still inherits the per-request
 * tenant transaction (middleware/tenant.ts) for its place in the wider request, and a caller outside
 * that context (a worker, a script) must open its own transaction.
 */
export async function detachConversationAcrossMailboxes(
  tenantDb: TenantDb,
  providerConversationId: string,
  actingUserId: string
): Promise<void> {
  await tenantDb
    .update(emailThreadBindings)
    .set({
      detachedAt: new Date(),
      updatedBy: actingUserId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailThreadBindings.provider, "microsoft_graph"),
        eq(emailThreadBindings.providerConversationId, providerConversationId),
        sql`${emailThreadBindings.detachedAt} IS NULL`
      )
    );
}

/**
 * The deal this CONVERSATION is currently filed under, from any active binding on it.
 *
 * The one place to ask "what deal is this thread on". It is deliberately NOT sourced from a message
 * row: backAssociateStoredMessagesForBinding writes emails.deal_id scoped to ONE mailbox's messages at
 * a time (eq(emails.userId, mailboxUserId)), so a mailbox that was never bound can sit at
 * deal_id = NULL even while another mailbox is actively bound. Ordered by mailbox_account_id so two
 * disagreeing bindings still answer stably.
 *
 * It is equally NOT sourced from getEmailThreadForMutation's `binding`, which is one arbitrary
 * mailbox's binding: on a thread that reached two mailboxes, that binding can be detached while the
 * conversation is still very much filed under a deal via the other one. Feeding THAT to
 * assertCanMutateEmailThread hands it a null boundDealId and 403s exactly the deal collaborator the
 * deal-write path exists to admit.
 *
 * ORPHANS — a binding whose mailbox_account_id no longer exists in user_graph_tokens. Common, not
 * exotic: revokeGraphTokens hard-DELETEs the row (graph-token-service.ts) while upsertGraphTokens only
 * updates in place, so every disconnect→reconnect mints a new token id and permanently orphans that
 * user's existing bindings. This is a LEFT join with orphans sorted LAST, not an inner join, because
 * the two available answers are wrong in different directions:
 *
 *   - Filtering orphans OUT (an inner join) disagrees with detachConversationAcrossMailboxes, which
 *     clears every active binding regardless of token — so a conversation held only by orphans would
 *     report boundDealId = null, 403 the collaborator whose deal it is actually filed under, and (when
 *     a mailbox owner detached it) wipe the filing with no audit row, because there was no deal id to
 *     file the record under.
 *   - Letting an orphan WIN would report a stale deal: bindConversationToDealAcrossMailboxes cannot
 *     rebind an orphan (bindThreadToDeal needs a live mailbox), so after a reassign the orphan still
 *     points at the deal the thread has left.
 *
 * Sorting live bindings first gives the live answer whenever one exists — identical to the inner join
 * in that case — and falls back to the orphan only when that is all there is, which is exactly the set
 * detach will clear. No status filter: a merely revoked/error token still resolves through
 * resolveMailboxUserId, so that binding is live as far as every rebind is concerned.
 */
export async function resolveActiveBindingDealIdForConversation(
  tenantDb: TenantDb,
  providerConversationId: string
): Promise<string | null> {
  const [currentBinding] = await tenantDb
    .select({ dealId: emailThreadBindings.dealId })
    .from(emailThreadBindings)
    .leftJoin(userGraphTokens, eq(userGraphTokens.id, emailThreadBindings.mailboxAccountId))
    .where(
      and(
        eq(emailThreadBindings.provider, "microsoft_graph"),
        eq(emailThreadBindings.providerConversationId, providerConversationId),
        sql`${emailThreadBindings.detachedAt} IS NULL`
      )
    )
    .orderBy(sql`${userGraphTokens.id} IS NULL`, emailThreadBindings.mailboxAccountId)
    .limit(1);

  return currentBinding?.dealId ?? null;
}

export async function previewThreadReassignmentImpact(
  tenantDb: TenantDb,
  input: {
    providerConversationId: string;
    nextDealId: string;
    /** Optional: the already-resolved current deal, so a caller that has just built the mutation gate's
     *  boundDealId does not run resolveActiveBindingDealIdForConversation a second time. It MUST be that
     *  same server-derived value — pass nothing rather than anything caller-supplied. */
    currentDealId?: string | null;
  }
) {
  // Counted across EVERY mailbox holding the conversation — the reassign moves all of them, so a
  // per-mailbox count would understate the blast radius shown to the user. Ordered oldest-first
  // (sent_at, then id to break ties) for stable affectedMessageIds across repeated calls.
  const messageRows = await tenantDb
    .select({ id: emails.id, dealId: emails.dealId })
    .from(emails)
    .where(eq(emails.graphConversationId, input.providerConversationId))
    .orderBy(sql`${emails.sentAt} ASC`, sql`${emails.id} ASC`);

  // currentDealId comes from the BINDING, not a message row — see
  // resolveActiveBindingDealIdForConversation, which is the same question the mutation routes ask to
  // build the gate's boundDealId, so the preview and the gate can never disagree about what deal the
  // thread is on.
  const currentDealId =
    input.currentDealId !== undefined
      ? input.currentDealId
      : await resolveActiveBindingDealIdForConversation(tenantDb, input.providerConversationId);

  return {
    affectedMessageCount: messageRows.length,
    affectedMessageIds: messageRows.map((row) => row.id),
    currentDealId,
    nextDealId: input.nextDealId,
  };
}

// detachThreadByConversation (the mailbox-SCOPED detach) is deliberately gone: its only caller was the
// detach route, which now uses detachConversationAcrossMailboxes. Detaching one mailbox at a time is the
// stranded-binding bug this change exists to close, so leaving the old helper exported would just be an
// invitation to reintroduce it.

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
  const [deal] = await tenantDb
    .select({
      id: deals.id,
      companyId: deals.companyId,
      propertyId: deals.propertyId,
      sourceLeadId: deals.sourceLeadId,
    })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);
  if (!deal) {
    throw new AppError(404, "Deal not found");
  }

  const messageRows = await tenantDb
    .select()
    .from(emails)
    .where(
      and(
        eq(emails.userId, mailboxUserId),
        eq(emails.graphConversationId, input.providerConversationId)
      )
    );

  const previousStatTargets = [];
  for (const email of messageRows) {
    previousStatTargets.push(...await collectEmailStatTargetsForEmail(tenantDb, email));
  }

  await tenantDb
    .update(emails)
    .set({
      dealId: input.dealId,
      assignedEntityType: "deal",
      assignedEntityId: input.dealId,
      assignmentStatus: "assigned",
      assignmentConfidence: "high",
      assignmentAmbiguityReason: null,
      threadBindingId: input.bindingId,
      syncedAt: new Date(),
    })
    .where(
      and(
        eq(emails.userId, mailboxUserId),
        eq(emails.graphConversationId, input.providerConversationId)
      )
    );

  for (const email of messageRows) {
    const updatedActivities = await tenantDb
      .update(activities)
      .set({
        sourceEntityType: "deal",
        sourceEntityId: input.dealId,
        companyId: deal.companyId ?? null,
        propertyId: deal.propertyId ?? null,
        leadId: deal.sourceLeadId ?? null,
        dealId: input.dealId,
      })
      .where(eq(activities.emailId, email.id))
      .returning({ id: activities.id });

    if (updatedActivities.length === 0) {
      await tenantDb.insert(activities).values({
        type: "email",
        responsibleUserId: email.userId,
        performedByUserId: input.actingUserId,
        sourceEntityType: "deal",
        sourceEntityId: input.dealId,
        companyId: deal.companyId ?? null,
        propertyId: deal.propertyId ?? null,
        leadId: deal.sourceLeadId ?? null,
        dealId: input.dealId,
        contactId: email.contactId ?? null,
        emailId: email.id,
        subject: email.subject ?? null,
        body: email.bodyPreview ?? (email.bodyHtml ? stripHtml(email.bodyHtml).substring(0, 1000) : null),
        occurredAt: email.sentAt,
      });
    }
  }

  await refreshEmailStatsForTargets(tenantDb, [
    ...previousStatTargets,
    { entityType: "deal", entityId: input.dealId },
    ...(deal.companyId ? [{ entityType: "company" as const, entityId: deal.companyId }] : []),
  ]);
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
    inArray(emails.direction, ASSIGNABLE_DIRECTIONS),
    eq(emails.assignmentStatus, filters.status ?? "unassigned"),
  ];

  if ((filters.status ?? "unassigned") === "unassigned") {
    conditions.push(sql`${emails.assignmentAmbiguityReason} IS NOT NULL`);
  }

  if (userId) {
    conditions.push(eq(emails.userId, userId));
  }

  if (filters.search && filters.search.trim().length >= 2) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${emails.subject} ILIKE ${term}`,
        sql`${emails.bodyPreview} ILIKE ${term}`,
        sql`${emails.fromAddress} ILIKE ${term}`,
        // Outbound queue items have the rep as fromAddress — match on the recipient too so a sent email
        // is searchable by the customer's address.
        sql`array_to_string(${emails.toAddresses}, ',') ILIKE ${term}`,
        sql`array_to_string(${emails.ccAddresses}, ',') ILIKE ${term}`
      )
    );
  }

  const where = and(...conditions);

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(emails).where(where);
  const emailRows = await tenantDb
    .select()
    .from(emails)
    .where(where)
    .orderBy(
      desc(sql`GREATEST(${emails.sentAt}, ${emails.syncedAt})`),
      desc(emails.sentAt)
    )
    .limit(limit)
    .offset(offset);

  const items: EmailAssignmentQueueItem[] = [];
  for (const emailRow of emailRows.filter((row) =>
    (filters.status ?? "unassigned") === "ignored" ? row.assignmentStatus === "ignored" : isEmailAssignmentQueueCandidate(row)
  )) {
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

    const item = {
      email: emailRow,
      companyId: contactRow?.companyId ?? companyId,
      contactName: contactRow ? `${contactRow.firstName} ${contactRow.lastName}`.trim() : null,
      companyName: contactRow?.companyName ?? companyName,
      candidateDeals: dealCandidates,
      candidateLeads: leadCandidates,
      candidateProperties: propertyCandidates,
      suggestedAssignment,
    } satisfies EmailAssignmentQueueItem;
    items.push(item);
  }

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
/** Fetch the sender's stored signature (public.users, reachable via tenantDb) and append it. */
async function appendUserSignature(tenantDb: TenantDb, userId: string, bodyHtml: string): Promise<string> {
  const [row] = await tenantDb
    .select({ emailSignature: users.emailSignature })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return composeBodyWithSignature(bodyHtml, row?.emailSignature);
}

export async function sendEmail(
  tenantDb: TenantDb,
  userId: string,
  input: SendEmailInput
): Promise<any> {
  const outboundAssociation = await resolveOutboundAssociation(tenantDb, input);
  if (!outboundAssociation) {
    throw new AppError(400, "Outbound email must be associated to a deal, company, or contact.");
  }
  const outboundAssignment = outboundAssociation.assignment;

  // Append the sender's CRM signature to the OUTBOUND body BEFORE both the dev-mock store and the
  // real Graph send — so it ships in-payload (Graph content + the stored outbound row both include
  // it; the Sent-folder copy then matches). Scope: user-composed mail only (this function);
  // system/Resend mail (sendSystemEmail) never reaches here, so it's never signed.
  input.bodyHtml = await appendUserSignature(tenantDb, userId, input.bodyHtml);

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
  // Capture the stable RFC822 Message-ID now, at draft creation, while the message id still resolves.
  // The Sent-folder sync later reads this same message back (with a DIFFERENT graph id) and dedups on
  // this value — without it, every CRM-composed email double-stores when its Sent copy is synced.
  const internetMessageId: string | null = draft.internetMessageId ?? null;

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

  // Store the email record. onConflictDoNothing closes the CRM-send-vs-worker race: if the Sent-folder
  // sync already stored this message's copy (same user + internet_message_id, enforced by the partial
  // unique index from migration 0163), this insert no-ops and we adopt the existing row below — the DB
  // enforces the dedup instead of relying on insert ordering.
  let [emailRecord] = await tenantDb
    .insert(emails)
    .values({
      graphMessageId,
      internetMessageId,
      graphConversationId,
      direction: "outbound",
      fromAddress,
      toAddresses: input.to,
      ccAddresses: input.cc ?? [],
      subject: input.subject,
      bodyPreview: stripHtml(input.bodyHtml).substring(0, 500),
      bodyHtml: input.bodyHtml,
      hasAttachments: false,
      contactId: outboundAssociation.links.contactId,
      ...outboundAssignment,
      userId,
      sentAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  let adopted = false;
  // The worker's row BEFORE reconcile — its (guessed) assignment targets need re-stat'ing afterward, since
  // this email no longer counts toward them once it's reattributed to the explicit CRM association.
  let adoptedPriorEmail: typeof emails.$inferSelect | null = null;
  if (!emailRecord) {
    // Lost the race — the worker already stored the Sent-folder copy. Adopt it (key on the stable
    // internet_message_id when we have it; otherwise on the graph message id).
    const [existing] = await tenantDb
      .select()
      .from(emails)
      .where(
        internetMessageId
          ? and(
              eq(emails.userId, userId),
              eq(emails.internetMessageId, internetMessageId),
              eq(emails.direction, "outbound")
            )
          : eq(emails.graphMessageId, graphMessageId)
      )
      .limit(1);
    emailRecord = existing;
    adoptedPriorEmail = existing ?? null;
    adopted = true;
  }
  if (!emailRecord) {
    throw new AppError(500, "Failed to persist the sent email record.");
  }

  if (adopted) {
    // The worker stored this Sent copy with a CONTACT-DERIVED/ambiguous assignment (recipient match), but
    // the sender chose an EXPLICIT association here — that one wins. Overwrite the assignment fields and
    // mark assigned. (The worker also already created the activity + refreshed stats, so those side
    // effects are skipped below for the adopted case to avoid duplicates.)
    const [reconciled] = await tenantDb
      .update(emails)
      .set({
        contactId: outboundAssociation.links.contactId,
        ...outboundAssignment,
        assignmentStatus: "assigned",
      })
      .where(eq(emails.id, emailRecord.id))
      .returning();
    emailRecord = reconciled ?? emailRecord;
  }

  if (outboundAssociation.links.dealId) {
    const mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, userId);
    const binding = await seedOutboundThreadBinding(tenantDb, {
      mailboxAccountId,
      provider: "microsoft_graph",
      providerConversationId: graphConversationId,
      normalizedSubject: normalizeEmailSubject(input.subject),
      participantFingerprint: buildParticipantFingerprint(input.to, input.cc ?? []),
      dealId: outboundAssociation.links.dealId,
      actingUserId: userId,
    });

    await tenantDb
      .update(emails)
      .set({ threadBindingId: binding.id })
      .where(eq(emails.id, emailRecord.id));

    emailRecord.threadBindingId = binding.id;
  }

  // Activity for the unified feed. For an ADOPTED row the worker already wrote an activity (with its
  // guessed target) — RECONCILE rather than blanket-skip: drop the worker's activity and write one carrying
  // the EXPLICIT CRM association, so the feed points at the deal/company the sender actually chose. (Without
  // this, a divergent worker guess leaves the activity + counters on the wrong target.)
  if (adopted) {
    await tenantDb.delete(activities).where(eq(activities.emailId, emailRecord.id));
  }
  await tenantDb.insert(activities).values({
    type: "email",
    responsibleUserId: userId,
    performedByUserId: userId,
    sourceEntityType: outboundAssociation.links.sourceEntityType,
    sourceEntityId: outboundAssociation.links.sourceEntityId,
    companyId: outboundAssociation.links.companyId,
    propertyId: outboundAssociation.links.propertyId,
    leadId: outboundAssociation.links.leadId,
    dealId: outboundAssociation.links.dealId,
    contactId: outboundAssociation.links.contactId,
    emailId: emailRecord.id,
    subject: input.subject,
    body: stripHtml(input.bodyHtml).substring(0, 1000),
    occurredAt: new Date(),
  });

  // Refresh the EXPLICIT targets; for an adopted row also re-stat the worker's PRIOR targets (this email
  // no longer counts toward them after the reattribution), so neither side's counters go stale.
  await refreshEmailStatsForEmailRecord(tenantDb, emailRecord);
  if (adopted && adoptedPriorEmail) {
    await refreshEmailStatsForEmailRecord(tenantDb, adoptedPriorEmail);
  }

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
  // Mirror the live path: a deterministic Message-ID so a same-message Sent-folder copy dedups in dev too.
  const internetMessageId = `<dev-${graphMessageId}@trockconstruction.com>`;
  const outboundAssociation = await resolveOutboundAssociation(tenantDb, input);
  if (!outboundAssociation) {
    throw new AppError(400, "Outbound email must be associated to a deal, company, or contact.");
  }
  const outboundAssignment = outboundAssociation.assignment;

  const [emailRecord] = await tenantDb
    .insert(emails)
    .values({
      graphMessageId,
      internetMessageId,
      direction: "outbound",
      fromAddress: "dev-user@trockconstruction.com",
      toAddresses: input.to,
      ccAddresses: input.cc ?? [],
      subject: input.subject,
      bodyPreview: stripHtml(input.bodyHtml).substring(0, 500),
      bodyHtml: input.bodyHtml,
      hasAttachments: false,
      contactId: outboundAssociation.links.contactId,
      ...outboundAssignment,
      userId,
      sentAt: new Date(),
    })
    .returning();

  if (outboundAssociation.links.dealId) {
    const mailboxAccountId = await resolveMailboxAccountIdForCrmUser(tenantDb, userId);
    const binding = await seedOutboundThreadBinding(tenantDb, {
      mailboxAccountId,
      provider: "microsoft_graph",
      providerConversationId: null,
      normalizedSubject: normalizeEmailSubject(input.subject),
      participantFingerprint: buildParticipantFingerprint(input.to, input.cc ?? []),
      dealId: outboundAssociation.links.dealId,
      actingUserId: userId,
    });

    await tenantDb
      .update(emails)
      .set({ threadBindingId: binding.id })
      .where(eq(emails.id, emailRecord.id));

    emailRecord.threadBindingId = binding.id;
  }

  await tenantDb.insert(activities).values({
    type: "email",
    responsibleUserId: userId,
    performedByUserId: userId,
    sourceEntityType: outboundAssociation.links.sourceEntityType,
    sourceEntityId: outboundAssociation.links.sourceEntityId,
    companyId: outboundAssociation.links.companyId,
    propertyId: outboundAssociation.links.propertyId,
    leadId: outboundAssociation.links.leadId,
    dealId: outboundAssociation.links.dealId,
    contactId: outboundAssociation.links.contactId,
    emailId: emailRecord.id,
    subject: input.subject,
    body: stripHtml(input.bodyHtml).substring(0, 1000),
    occurredAt: new Date(),
  });

  await refreshEmailStatsForEmailRecord(tenantDb, emailRecord);

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

  if (userId) {
    conditions.push(eq(emails.userId, userId));
  }

  const isEntityScoped = Boolean(
    filters.companyId || filters.dealId || filters.leadId || filters.contactId
  );
  if (!userId && isEntityScoped) {
    conditions.push(...activeEmailConditions());
    conditions.push(sql`${emails.assignmentStatus} <> 'ignored'`);
  }

  if (filters.companyId) {
    conditions.push(
      or(
        and(eq(emails.assignedEntityType, "company"), eq(emails.assignedEntityId, filters.companyId)),
        sql`${emails.dealId} IN (SELECT id FROM ${deals} WHERE ${deals.companyId} = ${filters.companyId})`,
        sql`${emails.contactId} IN (SELECT id FROM ${contacts} WHERE ${contacts.companyId} = ${filters.companyId})`,
        sql`${emails.assignedEntityType} = 'deal' AND ${emails.assignedEntityId} IN (SELECT id FROM ${deals} WHERE ${deals.companyId} = ${filters.companyId})`,
        sql`${emails.assignedEntityType} = 'contact' AND ${emails.assignedEntityId} IN (SELECT id FROM ${contacts} WHERE ${contacts.companyId} = ${filters.companyId})`
      )
    );
  } else if (filters.dealId) {
    const dealConditions = [
        eq(emails.dealId, filters.dealId),
        and(eq(emails.assignedEntityType, "deal"), eq(emails.assignedEntityId, filters.dealId)),
    ];
    if (filters.leadId) {
      dealConditions.push(and(eq(emails.assignedEntityType, "lead"), eq(emails.assignedEntityId, filters.leadId)));
    }
    conditions.push(or(...dealConditions));
  } else if (filters.leadId) {
    conditions.push(and(eq(emails.assignedEntityType, "lead"), eq(emails.assignedEntityId, filters.leadId)));
  }
  if (filters.contactId) {
    conditions.push(
      or(
        eq(emails.contactId, filters.contactId),
        and(eq(emails.assignedEntityType, "contact"), eq(emails.assignedEntityId, filters.contactId))
      )
    );
  }
  if (filters.direction) {
    conditions.push(eq(emails.direction, filters.direction));
  }
  applyInboxFilter(conditions, filters.filter);
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

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(emails).where(where);
  const emailRows = await tenantDb
    .select()
    .from(emails)
    .where(where)
    .orderBy(
      desc(sql`GREATEST(${emails.sentAt}, ${emails.syncedAt})`),
      desc(emails.sentAt)
    )
    .limit(limit)
    .offset(offset);

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
 * One row per real MESSAGE, out of the one-row-per-MAILBOX storage the sync deliberately keeps.
 *
 * The worker stores a separate emails row for every mailbox a message reached: graph_message_id is
 * unique per mailbox, and the internet_message_id dedup there is scoped `AND user_id = $2 AND
 * direction = 'outbound'` precisely so an internal A→B email keeps BOTH A's Sent copy and B's Inbox
 * copy (worker/src/jobs/email-sync.ts). That storage model is correct and is not what changes here —
 * the thread read is simply no longer mailbox-scoped, so it now sees every copy and would render the
 * conversation once per participant.
 *
 * PRESENTATION ONLY. This decides which ROW represents a message, never WHICH messages the caller may
 * see: every row handed in has already cleared the gate, and no row is dropped that does not have a
 * surviving sibling standing for the same message.
 *
 * THE INVARIANT: a collapsed list must NEVER reach assertCanMutateEmailThread. Its path 1 is
 * `thread.emails.some((e) => e.userId === user.id)`, so a participant whose only copy lost the
 * collapse would be 403'd off their own thread. That is structurally true today — this function is
 * module-private with one call site, inside getEmailThread and AFTER getEmailThreadForMutation has
 * produced the mutation context, while gateEmailThreadAccess calls getEmailThreadForMutation directly
 * and never getEmailThread — and it must stay true. The gate reads the RAW per-mailbox rows.
 *
 * Two rules:
 *   - Prefer the CALLER'S OWN copy. Starred/archived/deleted state lives on the per-mailbox row, so
 *     handing a participant somebody else's copy would show them their own mail with a stranger's
 *     state on it.
 *   - Otherwise keep the first copy in the thread's order, and keep it IN that position, so collapsing
 *     never reorders the conversation.
 *
 * Only ever collapses rows in DIFFERENT mailboxes. internet_message_id is a sender-supplied RFC822
 * header, so a repeated or spoofed one inside a single conversation would otherwise silently hide a
 * real message here while the deal Emails list — which does not collapse — still showed it, leaving
 * two surfaces disagreeing about what the thread contains. Two copies of ONE message live in two
 * DIFFERENT mailboxes by definition, so a repeat within a single mailbox is never a copy and never a
 * legitimate collapse.
 *
 * A NULL internet_message_id is left uncollapsed, deliberately. It is the ABSENCE of an identity, not
 * an identity shared with every other NULL: keying on it would fold a whole conversation of un-idd
 * messages into one and lose real messages — far worse than the doubling this exists to fix. The
 * column is nullable (shared/src/schema/tenant/emails.ts) and Graph does omit it, so this is a live
 * case, not a theoretical one.
 */
function collapseThreadMessageCopies<T extends { internetMessageId: string | null; userId: string }>(
  threadEmails: T[],
  viewerUserId?: string
): T[] {
  const slotByMessageId = new Map<string, number>();
  const collapsed: T[] = [];

  for (const email of threadEmails) {
    if (!email.internetMessageId) {
      collapsed.push(email);
      continue;
    }

    const slot = slotByMessageId.get(email.internetMessageId);
    if (slot === undefined) {
      slotByMessageId.set(email.internetMessageId, collapsed.length);
      collapsed.push(email);
      continue;
    }

    const kept = collapsed[slot];
    // Same mailbox: not a copy, whatever the header claims. Keep both rows.
    if (kept.userId === email.userId) {
      collapsed.push(email);
      continue;
    }

    // Reaching here means kept.userId !== email.userId, so "this row is the viewer's" already implies
    // "the kept one is not" — no second comparison needed.
    if (viewerUserId && email.userId === viewerUserId) {
      collapsed[slot] = email;
    }
  }

  return collapsed;
}

/**
 * Get all emails in a thread (grouped by graph_conversation_id).
 *
 * `userId` FILTERS the thread to one mailbox's copy of it. The routes deliberately pass nothing —
 * scoping the read 403s any deal collaborator who owns none of the messages, and the payload is what
 * renders the Reassign/Unassign controls.
 *
 * `options.viewerUserId` is the opposite kind of argument: it names who is LOOKING, and only so
 * collapseThreadMessageCopies can prefer their copy of a message held in several mailboxes. It must
 * never become a filter — passing it changes which row represents a message, never which messages come
 * back. It lives in an options object rather than a sixth positional string precisely so it cannot be
 * swapped with `userId` by accident; the two mean opposite things and TypeScript would not notice.
 *
 * `options.threadContext` lets a caller that has ALREADY resolved the mutation context hand it over
 * instead of paying for it twice — getEmailThreadForMutation is two more unindexed passes over
 * `emails`, and the thread GET's gate has just run it. Supply it ONLY when nothing has mutated since
 * it was resolved: a post-mutation refresh handed a pre-mutation context would report the binding the
 * thread has just moved OFF, so the reassign/detach routes deliberately pass nothing here.
 */
export async function getEmailThread(
  tenantDb: TenantDb,
  conversationId: string,
  userId?: string,
  userRole?: string,
  canViewDeal?: (dealId: string) => Promise<boolean>,
  options?: { viewerUserId?: string; threadContext?: EmailThreadMutationContext }
) : Promise<EmailThreadResponse> {
  if (!conversationId) return { binding: null, preview: null, emails: [] };

  const conditions: any[] = [eq(emails.graphConversationId, conversationId)];
  if (userId) {
    conditions.push(eq(emails.userId, userId));
  }

  // Thread view: chronological order (oldest first) for natural reading context. The id tiebreak
  // matches getEmailThreadForMutation's, so copies of one message that share a sent_at — the normal
  // case, since every mailbox's copy carries the sender's timestamp — always order the same way and
  // "the first copy" means something stable to the collapse below.
  const thread = await tenantDb
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(sql`${emails.sentAt} ASC`, sql`${emails.id} ASC`);

  if (thread.length === 0) {
    if (userId) {
      const existingThreadEmail = await findAnyEmailInConversation(tenantDb, conversationId);
      if (existingThreadEmail) {
        throw new AppError(403, "You do not have permission to view this email thread");
      }
    }
    return { binding: null, preview: null, emails: [] };
  }

  const mutationContext =
    options?.threadContext ?? (await getEmailThreadForMutation(tenantDb, conversationId, userId));
  const visibleThread = collapseThreadMessageCopies(thread, options?.viewerUserId ?? userId);

  let bindingPayload: EmailThreadResponse["binding"] = null;
  if (mutationContext.binding) {
    const [dealRow] = mutationContext.binding.dealId
      ? await tenantDb
          .select({ id: deals.id, name: deals.name })
          .from(deals)
          .where(eq(deals.id, mutationContext.binding.dealId))
          .limit(1)
      : [null];
    const bindingSourceEmail = visibleThread[0] ?? null;
    bindingPayload = {
      id: mutationContext.binding.id,
      mailboxAccountId: mutationContext.binding.mailboxAccountId,
      contactId: bindingSourceEmail?.contactId ?? null,
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
    emails: visibleThread,
  };
}

/**
 * Get emails for a user across all deals/contacts (inbox view).
 */
export async function getUserEmails(tenantDb: TenantDb, userId: string, filters: EmailFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 25;
  const offset = (page - 1) * limit;

  const baseConditions: any[] = [eq(emails.userId, userId), ...activeEmailConditions()];

  if (filters.direction) {
    baseConditions.push(eq(emails.direction, filters.direction));
  }
  if (filters.status) {
    baseConditions.push(eq(emails.assignmentStatus, filters.status));
  }
  if (filters.search && filters.search.trim().length >= 2) {
    const term = `%${filters.search.trim()}%`;
    baseConditions.push(
      or(
        sql`${emails.subject} ILIKE ${term}`,
        sql`${emails.bodyPreview} ILIKE ${term}`,
        sql`${emails.fromAddress} ILIKE ${term}`
      )
    );
  }

  const filteredConditions: any[] = [...baseConditions];
  applyInboxFilter(filteredConditions, filters.filter);

  const countWhere = and(...baseConditions);
  const where = and(...filteredConditions);

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(emails).where(where);
  const countsResult = await tenantDb
    .select({
      all: sql<number>`count(*)`,
      unread: sql<number>`count(*) FILTER (WHERE ${emailIsUnassignedCondition()})`,
      unassigned: sql<number>`count(*) FILTER (WHERE ${emailIsUnassignedCondition()})`,
      sent: sql<number>`count(*) FILTER (WHERE ${emails.direction} = 'outbound')`,
      linked: sql<number>`count(*) FILTER (WHERE ${emails.assignedEntityId} IS NOT NULL OR ${emails.dealId} IS NOT NULL OR ${emails.contactId} IS NOT NULL)`,
      today: sql<number>`count(*) FILTER (WHERE ${emails.sentAt} >= now() - interval '24 hours')`,
    })
    .from(emails)
    .where(countWhere);
  const emailRows = await tenantDb
    .select()
    .from(emails)
    .where(where)
    .orderBy(
      desc(sql`GREATEST(${emails.sentAt}, ${emails.syncedAt})`),
      desc(emails.sentAt)
    )
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    emails: emailRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    counts: {
      all: Number(countsResult[0]?.all ?? 0),
      unread: Number(countsResult[0]?.unread ?? 0),
      unassigned: Number(countsResult[0]?.unassigned ?? 0),
      sent: Number(countsResult[0]?.sent ?? 0),
      linked: Number(countsResult[0]?.linked ?? 0),
      today: Number(countsResult[0]?.today ?? 0),
    },
  };
}

export async function updateEmailInboxAction(
  tenantDb: TenantDb,
  emailId: string,
  userId: string,
  userRole: string,
  input: EmailInboxActionInput
) {
  const email = await getEmailById(tenantDb, emailId);
  if (!email) throw new AppError(404, "Email not found");
  if (email.userId !== userId) {
    throw new AppError(403, "You can only modify your own emails");
  }

  const updateValues: Partial<typeof emails.$inferInsert> = {};
  if (input.isStarred !== undefined) updateValues.isStarred = input.isStarred;
  if (input.archived !== undefined) updateValues.archivedAt = input.archived ? new Date() : null;
  if (input.deleted !== undefined) updateValues.deletedAt = input.deleted ? new Date() : null;

  if (Object.keys(updateValues).length === 0) {
    return email;
  }

  const [updated] = await tenantDb
    .update(emails)
    .set(updateValues)
    .where(eq(emails.id, emailId))
    .returning();

  return updated ?? email;
}

function deriveAssignmentStatus(email: {
  assignedEntityId?: string | null;
  dealId?: string | null;
}) {
  return email.assignedEntityId || email.dealId ? "assigned" : "unassigned";
}

export async function ignoreEmailAssignment(
  tenantDb: TenantDb,
  emailId: string,
  userId: string,
  userRole: string
) {
  const email = await getEmailById(tenantDb, emailId);
  if (!email) throw new AppError(404, "Email not found");
  if (email.userId !== userId) {
    throw new AppError(403, "You can only modify your own emails");
  }

  const statTargets = await collectEmailStatTargetsForEmail(tenantDb, email);

  const [updated] = await tenantDb
    .update(emails)
    .set({
      assignmentStatus: "ignored",
      syncedAt: new Date(),
    })
    .where(eq(emails.id, emailId))
    .returning();

  await refreshEmailStatsForTargets(tenantDb, statTargets);
  return updated ?? { ...email, assignmentStatus: "ignored" };
}

export async function unignoreEmailAssignment(
  tenantDb: TenantDb,
  emailId: string,
  userId: string,
  userRole: string
) {
  const email = await getEmailById(tenantDb, emailId);
  if (!email) throw new AppError(404, "Email not found");
  if (email.userId !== userId) {
    throw new AppError(403, "You can only modify your own emails");
  }

  const statTargets = await collectEmailStatTargetsForEmail(tenantDb, email);

  const assignmentStatus = deriveAssignmentStatus(email);
  const [updated] = await tenantDb
    .update(emails)
    .set({
      assignmentStatus,
      syncedAt: new Date(),
    })
    .where(eq(emails.id, emailId))
    .returning();

  await refreshEmailStatsForTargets(tenantDb, statTargets);
  return updated ?? { ...email, assignmentStatus };
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
      // Legacy/backfilled tasks may carry origin rules that are no longer in TASK_RULES.
      // Assignment must still succeed; we just skip suppression-window metadata.
      console.warn(
        `[email-assignment] Missing rule configuration for completed task originRule ${completedTask.originRule}`
      );
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
    assignedEntityType: "deal" | "company" | "property" | "lead" | "contact";
    assignedEntityId: string;
    assignedDealId?: string | null;
  },
  userRole: string,
  userId: string,
  officeId: string
): Promise<void> {
  const email = await getEmailById(tenantDb, emailId);
  if (!email) throw new AppError(404, "Email not found");
  if (email.userId !== userId) {
    throw new AppError(403, "You can only modify your own emails");
  }

  if (!["deal", "company", "property", "lead", "contact"].includes(input.assignedEntityType)) {
    throw new AppError(400, "Unsupported assignment target");
  }

  const assignedDealId = input.assignedEntityType === "deal" ? input.assignedDealId ?? input.assignedEntityId : null;
  if (input.assignedEntityType === "deal" && assignedDealId !== input.assignedEntityId) {
    throw new AppError(400, "assignedDealId must match assignedEntityId for deal assignments");
  }

  let assignmentLinks: {
    sourceEntityType: "company" | "property" | "lead" | "deal" | "contact";
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
  } else if (input.assignedEntityType === "contact") {
    const [contact] = await tenantDb
      .select({ id: contacts.id, companyId: contacts.companyId })
      .from(contacts)
      .where(eq(contacts.id, input.assignedEntityId))
      .limit(1);
    if (!contact) throw new AppError(404, "Contact not found");

    assignmentLinks = {
      sourceEntityType: "contact",
      sourceEntityId: input.assignedEntityId,
      companyId: contact.companyId ?? null,
      propertyId: null,
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

  const previousStatTargets = await collectEmailStatTargetsForEmail(tenantDb, email);
  const nextContactId = input.assignedEntityType === "contact" ? input.assignedEntityId : email.contactId ?? null;
  const nextStatTargets = await collectEmailStatTargetsForEmail(tenantDb, {
    assignedEntityType: input.assignedEntityType,
    assignedEntityId: input.assignedEntityId,
    dealId: assignedDealId,
    contactId: nextContactId,
  });

  await tenantDb
    .update(emails)
    .set({
      assignedEntityType: input.assignedEntityType,
      assignedEntityId: input.assignedEntityId,
      assignmentStatus: "assigned",
      assignmentConfidence: "high",
      assignmentAmbiguityReason: null,
      dealId: assignedDealId,
      contactId: nextContactId,
      syncedAt: new Date(),
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
      contactId: nextContactId,
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
      contactId: nextContactId,
      emailId: email.id,
      subject: email.subject ?? null,
      body: email.bodyPreview ?? (email.bodyHtml ? stripHtml(email.bodyHtml).substring(0, 1000) : null),
      occurredAt: email.sentAt,
    });
  }

  await refreshEmailStatsForTargets(tenantDb, [...previousStatTargets, ...nextStatTargets]);
  await completeInboundEmailTasks(tenantDb, emailId, userRole, userId, officeId);
}

export async function associateEmailToDeal(
  tenantDb: TenantDb,
  emailId: string,
  dealId: string
): Promise<void> {
  await tenantDb
    .update(emails)
    .set({
      ...assignmentUpdateForDeal(dealId),
      assignmentStatus: "assigned",
      syncedAt: new Date(),
    })
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
