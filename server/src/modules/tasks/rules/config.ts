import { assignTaskFromContext } from "./assignment.js";
import { scoreTaskPriority } from "./priority.js";
import type { TaskRuleDefinition, TaskRuleContext } from "./types.js";

function buildPriority(context: TaskRuleContext) {
  return scoreTaskPriority(
    context.priority ?? {
      dueProximity: 0,
      stageRisk: context.stage ? 10 : 0,
      staleAge: context.staleAge ?? 0,
      unreadInbound: context.unreadInbound ?? 0,
      dealValue: context.dealValue ?? 0,
    }
  );
}

const staleDealRuleId = "stale_deal";
const staleDealRule: TaskRuleDefinition = {
  id: staleDealRuleId,
  sourceEvent: "deal.updated",
  reasonCode: "stale_deal",
  suppressionWindowDays: 30,
  buildDedupeKey(context) {
    return context.dealId ? `deal:${context.dealId}` : null;
  },
  async buildTask(context) {
    if (!context.dealId) return null;

    const assignment = await assignTaskFromContext(context);
    const priority = buildPriority(context);

    return {
      title: `Follow up on deal ${context.dealId}`,
      description: "Deal activity indicates a stale follow-up is needed.",
      type: "stale_deal",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: staleDealRuleId,
      sourceRule: staleDealRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `deal:${context.dealId}`,
      reasonCode: "stale_deal",
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      entitySnapshot: {
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        dealId: context.dealId,
        stage: context.stage ?? null,
        staleAge: context.staleAge ?? null,
      },
      metadata: {
        assignment: assignment.machineReason,
        entityId: context.entityId,
        dealId: context.dealId,
      },
    };
  },
};

const inboundEmailReplyNeededRuleId = "inbound_email_reply_needed";
const inboundEmailReplyNeededRule: TaskRuleDefinition = {
  id: inboundEmailReplyNeededRuleId,
  sourceEvent: "email.received",
  reasonCode: "reply_needed",
  suppressionWindowDays: 30,
  buildDedupeKey(context) {
    return context.emailId && context.activeDealCount === 1 ? `email:${context.emailId}:reply_needed` : null;
  },
  async buildTask(context) {
    if (!context.emailId || context.activeDealCount !== 1 || !context.dealId) return null;

    const assignment = await assignTaskFromContext({
      ...context,
      manualOverrideId: context.taskAssigneeId ?? context.manualOverrideId,
    });
    const contactName = context.contactName?.trim() || "Contact";
    const subject = context.emailSubject?.trim() || "(No Subject)";

    return {
      title: `Reply to ${contactName}: ${subject}`,
      description: "An inbound email needs a deterministic response from the assigned rep.",
      type: "inbound_email",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: inboundEmailReplyNeededRuleId,
      sourceRule: inboundEmailReplyNeededRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `email:${context.emailId}:reply_needed`,
      reasonCode: "reply_needed",
      priority: "high",
      priorityScore: 80,
      status: "pending",
      dealId: context.dealId,
      contactId: context.contactId ?? null,
      emailId: context.emailId,
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "email",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        dealId: context.dealId,
        contactId: context.contactId ?? null,
        emailId: context.emailId,
        contactName,
        emailSubject: subject,
        activeDealCount: context.activeDealCount ?? null,
        activeDealNames: context.activeDealNames ?? [],
        summary: `Reply needed for ${contactName}`,
      },
      metadata: {
        assignment: assignment.machineReason,
        entityId: context.entityId,
        dealId: context.dealId,
        contactId: context.contactId,
        emailId: context.emailId,
      },
    };
  },
};

const inboundEmailDisambiguationRuleId = "inbound_email_deal_disambiguation";
const inboundEmailDisambiguationRule: TaskRuleDefinition = {
  id: inboundEmailDisambiguationRuleId,
  sourceEvent: "email.received",
  reasonCode: "deal_disambiguation",
  suppressionWindowDays: 30,
  buildDedupeKey(context) {
    return context.emailId && (context.activeDealCount ?? 0) > 1
      ? `email:${context.emailId}:deal_disambiguation`
      : null;
  },
  async buildTask(context) {
    if (!context.emailId || (context.activeDealCount ?? 0) <= 1) return null;

    const assignment = await assignTaskFromContext({
      ...context,
      manualOverrideId: context.taskAssigneeId ?? context.manualOverrideId,
    });
    const dealNames = (context.activeDealNames ?? []).join(", ");

    return {
      title: "Associate email to correct deal",
      description: dealNames
        ? `An inbound email was received for a contact with multiple active deals: ${dealNames}. Review and associate it to the correct deal.`
        : "An inbound email was received for a contact with multiple active deals. Review and associate it to the correct deal.",
      type: "inbound_email",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: inboundEmailDisambiguationRuleId,
      sourceRule: inboundEmailDisambiguationRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `email:${context.emailId}:deal_disambiguation`,
      reasonCode: "deal_disambiguation",
      priority: "normal",
      priorityScore: 50,
      status: "pending",
      dealId: null,
      contactId: context.contactId ?? null,
      emailId: context.emailId,
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "email",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        contactId: context.contactId ?? null,
        emailId: context.emailId,
        activeDealCount: context.activeDealCount ?? null,
        activeDealNames: context.activeDealNames ?? [],
        summary: "Review multiple active deals for inbound email",
      },
      metadata: {
        assignment: assignment.machineReason,
        entityId: context.entityId,
        contactId: context.contactId,
        emailId: context.emailId,
        activeDealNames: context.activeDealNames ?? [],
      },
    };
  },
};

export const TASK_RULES: TaskRuleDefinition[] = [
  staleDealRule,
  inboundEmailReplyNeededRule,
  inboundEmailDisambiguationRule,
];
