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
      sourceEvent: context.sourceEvent,
      dedupeKey: `deal:${context.dealId}`,
      reasonCode: "stale_deal",
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      metadata: {
        assignment: assignment.machineReason,
        entityId: context.entityId,
        dealId: context.dealId,
      },
    };
  },
};

const inboundEmailRuleId = "inbound_email";
const inboundEmailRule: TaskRuleDefinition = {
  id: inboundEmailRuleId,
  sourceEvent: "email.received",
  reasonCode: "inbound_email",
  buildDedupeKey(context) {
    return context.emailId ? `email:${context.emailId}` : null;
  },
  async buildTask(context) {
    if (!context.emailId) return null;

    const assignment = await assignTaskFromContext(context);
    const priority = buildPriority(context);

    return {
      title: `Respond to email ${context.emailId}`,
      description: "An inbound email needs a deterministic response task.",
      type: "inbound_email",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: inboundEmailRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `email:${context.emailId}`,
      reasonCode: "inbound_email",
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      metadata: {
        assignment: assignment.machineReason,
        entityId: context.entityId,
        emailId: context.emailId,
      },
    };
  },
};

export const TASK_RULES: TaskRuleDefinition[] = [staleDealRule, inboundEmailRule];
