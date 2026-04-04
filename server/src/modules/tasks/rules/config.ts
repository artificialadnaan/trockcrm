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

function buildFixedPriority(score: number) {
  return scoreTaskPriority({
    dueProximity: score,
    stageRisk: 0,
    staleAge: 0,
    unreadInbound: 0,
    dealValue: 0,
  });
}

function buildBidDeadlineRule(daysUntil: number, titlePrefix: string, priorityScore: number): TaskRuleDefinition {
  const ruleId = `bid_deadline_${daysUntil}_day`;
  return {
    id: ruleId,
    sourceEvent: "cron.bid_deadline",
    reasonCode: ruleId,
    suppressionWindowDays: 0,
    buildDedupeKey(context) {
      if (!context.dealId || context.daysUntil !== daysUntil) return null;
      return `deal:${context.dealId}:bid_deadline:${daysUntil}`;
    },
    async buildTask(context) {
      if (!context.dealId || context.daysUntil !== daysUntil || !context.dealName) return null;

      const assignment = await assignTaskFromContext({
        entityId: context.entityId,
        manualOverrideId: context.taskAssigneeId ?? context.manualOverrideId,
        dealOwnerId: context.dealOwnerId,
        contactLinkedRepId: context.contactLinkedRepId,
        recentActorId: context.recentActorId,
        officeFallbackId: context.officeFallbackId,
      });

      if (!assignment.assignedTo) return null;

      const priority = buildFixedPriority(priorityScore);

      return {
        title: `${titlePrefix}: ${context.dealName}`,
        description: "The deal is approaching its expected close date.",
        type: "system",
        assignedTo: assignment.assignedTo,
        officeId: context.officeId,
        originRule: ruleId,
        sourceRule: ruleId,
        sourceEvent: context.sourceEvent,
        dedupeKey: `deal:${context.dealId}:bid_deadline:${daysUntil}`,
        reasonCode: ruleId,
        priority: priority.band,
        priorityScore: priority.score,
        status: "pending",
        dealId: context.dealId,
        entitySnapshot: {
          schemaVersion: 1,
          entityType: "deal",
          entityId: context.entityId,
          officeId: context.officeId,
          sourceEvent: context.sourceEvent,
          dealId: context.dealId,
          dealName: context.dealName,
          daysUntil: context.daysUntil,
          summary: `${context.dealName} closes in ${daysUntil} days`,
        },
        metadata: {
          entityId: context.entityId,
          dealId: context.dealId,
          dealName: context.dealName,
          daysUntil: context.daysUntil,
          assignment: assignment.machineReason,
        },
      };
    },
  };
}

const coldLeadWarmingRuleId = "cold_lead_warming";
const coldLeadWarmingRule: TaskRuleDefinition = {
  id: coldLeadWarmingRuleId,
  sourceEvent: "cron.cold_lead_warming",
  reasonCode: coldLeadWarmingRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    return context.contactId ? `contact:${context.contactId}:cold_lead_warming` : null;
  },
  async buildTask(context) {
    if (!context.contactId || !context.contactName || !context.dealId) return null;

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId ?? context.manualOverrideId,
      dealOwnerId: context.dealOwnerId,
      contactLinkedRepId: context.contactLinkedRepId,
      recentActorId: context.recentActorId,
      officeFallbackId: context.officeFallbackId,
    });

    if (!assignment.assignedTo) return null;

    const priority = buildFixedPriority(50);
    const noTouchDays = context.noTouchDays ?? 60;

    return {
      title: `Re-engage ${context.contactName} — no contact in ${noTouchDays}+ days`,
      description: "A cold lead follow-up is needed for a contact with an active deal.",
      type: "follow_up",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: coldLeadWarmingRuleId,
      sourceRule: coldLeadWarmingRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `contact:${context.contactId}:cold_lead_warming`,
      reasonCode: coldLeadWarmingRuleId,
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      dealId: context.dealId,
      contactId: context.contactId,
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "contact",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        contactId: context.contactId,
        contactName: context.contactName,
        dealId: context.dealId,
        noTouchDays,
        summary: `${context.contactName} has not been contacted in ${noTouchDays}+ days`,
      },
      metadata: {
        entityId: context.entityId,
        contactId: context.contactId,
        dealId: context.dealId,
        noTouchDays,
        assignment: assignment.machineReason,
      },
    };
  },
};

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
  buildBidDeadlineRule(14, "Prepare final bid for", 40),
  buildBidDeadlineRule(7, "Confirm bid submission for", 65),
  buildBidDeadlineRule(1, "BID DUE TOMORROW", 90),
  coldLeadWarmingRule,
];
