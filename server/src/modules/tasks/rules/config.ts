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

function addCalendarDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addBusinessDays(date: Date, days: number) {
  const result = new Date(date);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dayOfWeek = result.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      added++;
    }
  }

  return result;
}

function formatDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    return value.includes("T") ? value.split("T")[0] : value;
  }

  return value.toISOString().split("T")[0] ?? null;
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function formatDateOnly(value: Date | string | null | undefined) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function buildContactOnboardingRule(
  id: string,
  title: string,
  type: "touchpoint" | "follow_up",
  dueOffsetDays: number,
  priorityScore: number,
  dedupeSuffix: string
): TaskRuleDefinition {
  return {
    id,
    sourceEvent: "contact.created",
    reasonCode: id,
    suppressionWindowDays: 0,
    buildDedupeKey(context) {
      if (!context.contactId || !context.taskAssigneeId) return null;
      return `contact:${context.contactId}:assignee:${context.taskAssigneeId}:onboarding:${dedupeSuffix}`;
    },
    async buildTask(context) {
      if (!context.contactId || !context.taskAssigneeId) return null;

      const assignment = await assignTaskFromContext({
        entityId: context.entityId,
        manualOverrideId: context.taskAssigneeId,
      });

      if (!assignment.assignedTo) return null;

      const priority = buildFixedPriority(priorityScore);
      const contactName = context.contactName?.trim() || "new contact";

      return {
        title: title.replace("{contactName}", contactName),
        type,
        assignedTo: assignment.assignedTo,
        officeId: context.officeId,
        originRule: id,
        sourceRule: id,
        sourceEvent: context.sourceEvent,
        dedupeKey: `contact:${context.contactId}:assignee:${context.taskAssigneeId}:onboarding:${dedupeSuffix}`,
        reasonCode: id,
        priority: priority.band,
        priorityScore: priority.score,
        status: "pending",
        contactId: context.contactId,
        dueAt: addCalendarDays(context.now, dueOffsetDays),
        entitySnapshot: {
          schemaVersion: 1,
          entityType: "contact",
          entityId: context.entityId,
          officeId: context.officeId,
          sourceEvent: context.sourceEvent,
          contactId: context.contactId,
          contactName,
          summary: title.replace("{contactName}", contactName),
        },
        metadata: {
          entityId: context.entityId,
          contactId: context.contactId,
          assignment: assignment.machineReason,
        },
      };
    },
  };
}

const contactOnboardingIntroEmailRule = buildContactOnboardingRule(
  "contact_onboarding_intro_email",
  "Send intro email to {contactName}",
  "touchpoint",
  0,
  70,
  "intro_email"
);

const contactOnboardingFollowUpCallRule = buildContactOnboardingRule(
  "contact_onboarding_follow_up_call",
  "Follow-up call with {contactName}",
  "follow_up",
  3,
  50,
  "follow_up_call"
);

const contactOnboardingCheckResponseRule = buildContactOnboardingRule(
  "contact_onboarding_check_response",
  "Check response from {contactName}",
  "follow_up",
  7,
  50,
  "check_response"
);

const activityMeetingFollowUpRuleId = "activity_meeting_follow_up";
const activityMeetingFollowUpRule: TaskRuleDefinition = {
  id: activityMeetingFollowUpRuleId,
  sourceEvent: "activity.created",
  reasonCode: activityMeetingFollowUpRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    if (!context.taskAssigneeId) return null;
    if (context.contactId) {
      return `contact:${context.contactId}:assignee:${context.taskAssigneeId}:meeting_follow_up`;
    }
    if (context.dealId) {
      return `deal:${context.dealId}:assignee:${context.taskAssigneeId}:meeting_follow_up`;
    }
    return null;
  },
  async buildTask(context) {
    if (!context.taskAssigneeId) return null;

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId,
    });

    if (!assignment.assignedTo) return null;

    const priority = buildFixedPriority(70);
    const contactName = context.contactName?.trim() || "contact";

    return {
      title: `Send follow-up from meeting with ${contactName}`,
      description: "A meeting follow-up is needed for the assigned rep.",
      type: "follow_up",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: activityMeetingFollowUpRuleId,
      sourceRule: activityMeetingFollowUpRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: context.contactId
        ? `contact:${context.contactId}:assignee:${context.taskAssigneeId}:meeting_follow_up`
        : context.dealId
          ? `deal:${context.dealId}:assignee:${context.taskAssigneeId}:meeting_follow_up`
          : "",
      reasonCode: activityMeetingFollowUpRuleId,
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      dealId: context.dealId ?? null,
      contactId: context.contactId ?? null,
      dueAt: addBusinessDays(context.now, 2),
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "activity",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        contactId: context.contactId ?? null,
        dealId: context.dealId ?? null,
        contactName,
        summary: `Follow up after meeting with ${contactName}`,
      },
      metadata: {
        entityId: context.entityId,
        contactId: context.contactId ?? null,
        dealId: context.dealId ?? null,
        assignment: assignment.machineReason,
      },
    };
  },
};

const dailyCloseDateFollowUpRuleId = "daily_close_date_follow_up";
const dailyCloseDateFollowUpRule: TaskRuleDefinition = {
  id: dailyCloseDateFollowUpRuleId,
  sourceEvent: "cron.daily_task_generation.close_date_follow_up",
  reasonCode: dailyCloseDateFollowUpRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    return context.dealId ? `deal:${context.dealId}:daily_close_date_follow_up` : null;
  },
  async buildTask(context) {
    if (!context.dealId || !context.dealName || !context.dealNumber || !context.taskAssigneeId) return null;

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId,
    });

    if (!assignment.assignedTo) return null;

    const dueDateText = formatDateOnly(context.dueAt) ?? formatDateOnly(context.now);

    return {
      title: `Follow up: ${context.dealNumber} closes ${dueDateText ?? "unknown"}`,
      description: `${context.dealName} has an expected close date of ${dueDateText}. Ensure all pre-close tasks are complete.`,
      type: "follow_up",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: dailyCloseDateFollowUpRuleId,
      sourceRule: dailyCloseDateFollowUpRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `deal:${context.dealId}:daily_close_date_follow_up`,
      reasonCode: dailyCloseDateFollowUpRuleId,
      priority: "high",
      priorityScore: 65,
      status: "pending",
      dealId: context.dealId,
      dueAt: context.dueAt ?? startOfDay(context.now),
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "deal",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        dealId: context.dealId,
        dealName: context.dealName,
        dealNumber: context.dealNumber,
        closeDate: dueDateText,
        summary: `${context.dealName} closes ${dueDateText}`,
      },
      metadata: {
        entityId: context.entityId,
        dealId: context.dealId,
        dealNumber: context.dealNumber,
        assignment: assignment.machineReason,
      },
    };
  },
};

const dailyFirstOutreachTouchpointRuleId = "daily_first_outreach_touchpoint";
const dailyFirstOutreachTouchpointRule: TaskRuleDefinition = {
  id: dailyFirstOutreachTouchpointRuleId,
  sourceEvent: "cron.daily_task_generation.first_outreach_touchpoint",
  reasonCode: dailyFirstOutreachTouchpointRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    return context.contactId ? `contact:${context.contactId}:daily_first_outreach_touchpoint` : null;
  },
  async buildTask(context) {
    if (!context.contactId || !context.contactName || !context.taskAssigneeId) return null;

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId,
    });

    if (!assignment.assignedTo) return null;

    const contactName = context.contactName.trim();

    return {
      title: `First outreach needed: ${contactName}`,
      type: "touchpoint",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: dailyFirstOutreachTouchpointRuleId,
      sourceRule: dailyFirstOutreachTouchpointRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `contact:${context.contactId}:daily_first_outreach_touchpoint`,
      reasonCode: dailyFirstOutreachTouchpointRuleId,
      priority: "normal",
      priorityScore: 40,
      status: "pending",
      contactId: context.contactId,
      dueAt: startOfDay(context.now),
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "contact",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        contactId: context.contactId,
        contactName,
        summary: `First outreach needed for ${contactName}`,
      },
      metadata: {
        entityId: context.entityId,
        contactId: context.contactId,
        assignment: assignment.machineReason,
      },
    };
  },
};

const dailyCadenceOverdueFollowUpRuleId = "daily_cadence_overdue_follow_up";
const dailyCadenceOverdueFollowUpRule: TaskRuleDefinition = {
  id: dailyCadenceOverdueFollowUpRuleId,
  sourceEvent: "cron.daily_task_generation.cadence_overdue_follow_up",
  reasonCode: dailyCadenceOverdueFollowUpRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    return context.dealId ? `deal:${context.dealId}:daily_cadence_overdue_follow_up` : null;
  },
  async buildTask(context) {
    if (
      !context.dealId ||
      !context.dealName ||
      !context.dealNumber ||
      !context.contactId ||
      !context.contactName ||
      !context.taskAssigneeId ||
      context.touchpointCadenceDays == null
    ) {
      return null;
    }

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId,
    });

    if (!assignment.assignedTo) return null;

    const lastContactText = formatDateOnly(context.lastContactedAt) ?? "Never";

    return {
      title: `Contact Follow-Up: ${context.contactName}`,
      description: `Touchpoint cadence overdue for ${context.contactName} on deal ${context.dealNumber}. Last contact: ${lastContactText}`,
      type: "follow_up",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: dailyCadenceOverdueFollowUpRuleId,
      sourceRule: dailyCadenceOverdueFollowUpRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `deal:${context.dealId}:daily_cadence_overdue_follow_up`,
      reasonCode: dailyCadenceOverdueFollowUpRuleId,
      priority: "normal",
      priorityScore: 40,
      status: "pending",
      dealId: context.dealId,
      contactId: context.contactId,
      dueAt: startOfDay(context.now),
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "contact",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        contactId: context.contactId,
        contactName: context.contactName,
        dealId: context.dealId,
        dealNumber: context.dealNumber,
        lastContactedAt: lastContactText,
        touchpointCadenceDays: context.touchpointCadenceDays,
        summary: `Touchpoint cadence overdue for ${context.contactName} on deal ${context.dealNumber}`,
      },
      metadata: {
        entityId: context.entityId,
        contactId: context.contactId,
        dealId: context.dealId,
        dealNumber: context.dealNumber,
        lastContactedAt: lastContactText,
        touchpointCadenceDays: context.touchpointCadenceDays,
        assignment: assignment.machineReason,
      },
    };
  },
};

const staleLeadRuleId = "stale_lead";
const staleLeadRule: TaskRuleDefinition = {
  id: staleLeadRuleId,
  sourceEvent: "cron.daily_task_generation.stale_lead",
  reasonCode: staleLeadRuleId,
  suppressionWindowDays: 30,
  preserveAssignedToOnRefresh: true,
  buildDedupeKey(context) {
    return context.leadId ? `lead:${context.leadId}` : null;
  },
  async buildTask(context) {
    if (!context.leadId || !context.taskAssigneeId) return null;

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId,
      recentActorId: context.recentActorId,
      officeFallbackId: context.officeFallbackId,
    });

    if (!assignment.assignedTo) return null;

    const leadName = context.leadName?.trim() || `Lead ${context.leadId}`;
    const stageName = context.stage?.trim() || "current stage";
    const staleAge = Math.max(context.staleAge ?? 0, 0);
    const priority = scoreTaskPriority({
      dueProximity: 20,
      stageRisk: context.stage ? 15 : 0,
      staleAge: Math.min(staleAge * 2, 45),
      unreadInbound: 0,
      dealValue: 0,
    });

    return {
      title: `Re-engage stale lead ${leadName}`,
      description: `Lead "${leadName}" has been in ${stageName} for ${staleAge} days without progression.`,
      type: "follow_up",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: staleLeadRuleId,
      sourceRule: staleLeadRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `lead:${context.leadId}`,
      reasonCode: staleLeadRuleId,
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      dueAt: startOfDay(context.now),
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "lead",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        leadId: context.leadId,
        leadName,
        stage: stageName,
        staleAge,
        summary: `Lead "${leadName}" is stale in ${stageName}`,
      },
      metadata: {
        entityId: context.entityId,
        leadId: context.leadId,
        leadName,
        stage: stageName,
        staleAge,
        assignment: assignment.machineReason,
      },
    };
  },
};

function buildWonDealHandoffRule(
  id: string,
  titleBuilder: (context: TaskRuleContext) => string,
  priorityScore: number,
  dueOffsetDays: number,
  dedupeSuffix: string
): TaskRuleDefinition {
  return {
    id,
    sourceEvent: "deal.won.handoff",
    reasonCode: id,
    suppressionWindowDays: 0,
    buildDedupeKey(context) {
      return context.dealId ? `deal:${context.dealId}:won_handoff:${dedupeSuffix}` : null;
    },
    async buildTask(context) {
      if (!context.dealId || !context.dealName) return null;

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
      const dueAt = addCalendarDays(context.now, dueOffsetDays);
      const title = titleBuilder(context);

      return {
        title,
        type: "system",
        assignedTo: assignment.assignedTo,
        officeId: context.officeId,
        originRule: id,
        sourceRule: id,
        sourceEvent: context.sourceEvent,
        dedupeKey: `deal:${context.dealId}:won_handoff:${dedupeSuffix}`,
        reasonCode: id,
        priority: priority.band,
        priorityScore: priority.score,
        status: "pending",
        dealId: context.dealId,
        dueAt,
        entitySnapshot: {
          schemaVersion: 1,
          entityType: "deal",
          entityId: context.entityId,
          officeId: context.officeId,
          sourceEvent: context.sourceEvent,
          dealId: context.dealId,
          dealName: context.dealName,
          primaryContactName: context.primaryContactName ?? null,
          summary: title,
        },
        metadata: {
          entityId: context.entityId,
          dealId: context.dealId,
          dealName: context.dealName,
          primaryContactName: context.primaryContactName ?? null,
          assignment: assignment.machineReason,
        },
      };
    },
  };
}

const dealWonKickoffRule = buildWonDealHandoffRule(
  "deal_won_schedule_kickoff",
  (context) => `Schedule kickoff meeting for ${context.dealName}`,
  90,
  0,
  "schedule_kickoff"
);

const dealWonWelcomePacketRule = buildWonDealHandoffRule(
  "deal_won_send_welcome_packet",
  (context) => `Send welcome packet to ${context.primaryContactName ?? "primary contact"}`,
  70,
  1,
  "send_welcome_packet"
);

const dealWonIntroduceTeamRule = buildWonDealHandoffRule(
  "deal_won_introduce_project_team",
  (context) => `Introduce project team for ${context.dealName}`,
  50,
  2,
  "introduce_project_team"
);

const dealWonVerifyProcoreRule = buildWonDealHandoffRule(
  "deal_won_verify_procore_project",
  (context) => `Verify Procore project created for ${context.dealName}`,
  50,
  3,
  "verify_procore_project"
);

const dealWonCrossSellRuleId = "deal_won_cross_sell_opportunity";
const dealWonCrossSellRule: TaskRuleDefinition = {
  id: dealWonCrossSellRuleId,
  sourceEvent: "deal.won.cross_sell",
  reasonCode: dealWonCrossSellRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    return context.dealId && context.projectTypeId
      ? `deal:${context.dealId}:cross_sell:${context.projectTypeId}`
      : null;
  },
  async buildTask(context) {
    if (!context.dealId || !context.projectTypeId || !context.projectTypeName || !context.companyName) {
      return null;
    }

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
    const dueAt = addCalendarDays(context.now, 14);

    return {
      title: `Explore ${context.projectTypeName} opportunities with ${context.companyName}`,
      description: `${context.companyName} just won deal "${context.dealName}" (${context.dealNumber}). Consider cross-selling ${context.projectTypeName} services.`,
      type: "system",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: dealWonCrossSellRuleId,
      sourceRule: dealWonCrossSellRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `deal:${context.dealId}:cross_sell:${context.projectTypeId}`,
      reasonCode: dealWonCrossSellRuleId,
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      dealId: context.dealId,
      dueAt,
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "deal",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        dealId: context.dealId,
        dealName: context.dealName ?? null,
        dealNumber: context.dealNumber ?? null,
        companyName: context.companyName,
        projectTypeId: context.projectTypeId,
        projectTypeName: context.projectTypeName,
        summary: `Cross-sell ${context.projectTypeName} with ${context.companyName}`,
      },
      metadata: {
        entityId: context.entityId,
        dealId: context.dealId,
        dealName: context.dealName ?? null,
        dealNumber: context.dealNumber ?? null,
        companyName: context.companyName,
        projectTypeId: context.projectTypeId,
        projectTypeName: context.projectTypeName,
        assignment: assignment.machineReason,
      },
    };
  },
};

const dealLostCompetitorIntelRuleId = "deal_lost_competitor_intel";
const dealLostCompetitorIntelRule: TaskRuleDefinition = {
  id: dealLostCompetitorIntelRuleId,
  sourceEvent: "deal.lost.competitor_intel",
  reasonCode: dealLostCompetitorIntelRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    return context.dealId && context.triggerDealId && context.lostCompetitor
      ? `deal:${context.dealId}:lost_competitor:${context.triggerDealId}:${context.lostCompetitor}`
      : null;
  },
  async buildTask(context) {
    if (!context.dealId || !context.dealName || !context.triggerDealId || !context.triggerDealName || !context.lostCompetitor) {
      return null;
    }

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId ?? context.manualOverrideId,
      dealOwnerId: context.dealOwnerId,
      contactLinkedRepId: context.contactLinkedRepId,
      recentActorId: context.recentActorId,
      officeFallbackId: context.officeFallbackId,
    });

    if (!assignment.assignedTo) return null;

    const priority = buildFixedPriority(80);
    const contactName = context.contactName?.trim() || "contact";

    return {
      title: `Heads up: ${contactName} chose ${context.lostCompetitor} on ${context.triggerDealName}. Review strategy for ${context.dealName}`,
      description: `${context.lostCompetitor} won ${context.triggerDealName}. Review the active deal strategy for ${context.dealName}.`,
      type: "system",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: dealLostCompetitorIntelRuleId,
      sourceRule: dealLostCompetitorIntelRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `deal:${context.dealId}:lost_competitor:${context.triggerDealId}:${context.lostCompetitor}`,
      reasonCode: dealLostCompetitorIntelRuleId,
      priority: priority.band,
      priorityScore: priority.score,
      status: "pending",
      dealId: context.dealId,
      dueAt: context.now,
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "deal",
        entityId: context.entityId,
        officeId: context.officeId,
        sourceEvent: context.sourceEvent,
        dealId: context.dealId,
        dealName: context.dealName,
        triggerDealId: context.triggerDealId,
        triggerDealName: context.triggerDealName,
        triggerDealNumber: context.triggerDealNumber ?? null,
        lostCompetitor: context.lostCompetitor,
        contactName,
        summary: `Review ${context.dealName} after ${context.lostCompetitor} won ${context.triggerDealName}`,
      },
      metadata: {
        entityId: context.entityId,
        dealId: context.dealId,
        dealName: context.dealName,
        triggerDealId: context.triggerDealId,
        triggerDealName: context.triggerDealName,
        triggerDealNumber: context.triggerDealNumber ?? null,
        lostCompetitor: context.lostCompetitor,
        contactName,
        assignment: assignment.machineReason,
      },
    };
  },
};

function buildScopingActivatedRule(input: {
  id: string;
  sourceEvent: "scoping_intake.activated.estimating" | "scoping_intake.activated.service";
  dedupeSuffix: string;
  title: (context: TaskRuleContext) => string;
  description: (context: TaskRuleContext) => string;
  priorityScore: number;
  dueOffsetDays: number;
}) {
  return {
    id: input.id,
    sourceEvent: input.sourceEvent,
    reasonCode: input.id,
    suppressionWindowDays: 0,
    buildDedupeKey(context: TaskRuleContext) {
      return context.dealId ? `deal:${context.dealId}:scoping_handoff:${input.dedupeSuffix}` : null;
    },
    async buildTask(context: TaskRuleContext) {
      if (!context.dealId || !context.dealName) {
        return null;
      }

      const assignment = await assignTaskFromContext({
        entityId: context.entityId,
        manualOverrideId: context.taskAssigneeId ?? context.manualOverrideId,
        dealOwnerId: context.dealOwnerId,
        contactLinkedRepId: context.contactLinkedRepId,
        recentActorId: context.recentActorId,
        officeFallbackId: context.officeFallbackId,
      });

      if (!assignment.assignedTo) return null;

      const priority = buildFixedPriority(input.priorityScore);
      const dueAt = addBusinessDays(context.now, input.dueOffsetDays);
      const title = input.title(context);

      return {
        title,
        description: input.description(context),
        type: "system",
        assignedTo: assignment.assignedTo,
        officeId: context.officeId,
        originRule: input.id,
        sourceRule: input.id,
        sourceEvent: context.sourceEvent,
        dedupeKey: `deal:${context.dealId}:scoping_handoff:${input.dedupeSuffix}`,
        reasonCode: input.id,
        priority: priority.band,
        priorityScore: priority.score,
        status: "pending",
        dealId: context.dealId,
        dueAt,
        entitySnapshot: {
          schemaVersion: 1,
          entityType: "deal",
          entityId: context.entityId,
          officeId: context.officeId,
          sourceEvent: context.sourceEvent,
          dealId: context.dealId,
          dealName: context.dealName,
          dealNumber: context.dealNumber ?? null,
          summary: title,
        },
        metadata: {
          entityId: context.entityId,
          dealId: context.dealId,
          dealName: context.dealName,
          dealNumber: context.dealNumber ?? null,
          assignment: assignment.machineReason,
        },
      };
    },
  } satisfies TaskRuleDefinition;
}

const scopingEstimatingReviewRule = buildScopingActivatedRule({
  id: "scoping_estimating_review_handoff",
  sourceEvent: "scoping_intake.activated.estimating",
  dedupeSuffix: "estimating_review",
  title: (context) => `Review scoping intake for ${context.dealName}`,
  description: (context) =>
    `Scoping is complete. Start estimating handoff for ${context.dealName} (${context.dealNumber ?? "deal"}).`,
  priorityScore: 70,
  dueOffsetDays: 0,
});

const scopingServiceReviewRule = buildScopingActivatedRule({
  id: "scoping_service_review_handoff",
  sourceEvent: "scoping_intake.activated.service",
  dedupeSuffix: "service_review",
  title: (context) => `Review service handoff for ${context.dealName}`,
  description: (context) =>
    `Scoping is complete. Start service handoff for ${context.dealName} (${context.dealNumber ?? "deal"}).`,
  priorityScore: 65,
  dueOffsetDays: 0,
});

const weeklyPipelineDigestRuleId = "weekly_pipeline_digest";
const weeklyPipelineDigestRule: TaskRuleDefinition = {
  id: weeklyPipelineDigestRuleId,
  sourceEvent: "cron.weekly_digest",
  reasonCode: weeklyPipelineDigestRuleId,
  suppressionWindowDays: 0,
  buildDedupeKey(context) {
    if (!context.taskAssigneeId) return null;
    const digestDate = formatDate(context.now);
    return `office:${context.officeId}:assignee:${context.taskAssigneeId}:weekly_digest:${digestDate}`;
  },
  async buildTask(context) {
    if (!context.taskAssigneeId) return null;

    const assignment = await assignTaskFromContext({
      entityId: context.entityId,
      manualOverrideId: context.taskAssigneeId,
    });

    if (!assignment.assignedTo) return null;

    const staleCount = context.staleCount ?? 0;
    const approachingCount = context.approachingCount ?? 0;
    const newDealsCount = context.newDealsCount ?? 0;
    const pipelineValue = context.pipelineValue ?? 0;
    const formattedValue = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(pipelineValue);
    const generatedLabel = context.now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const title = `Weekly Digest: ${staleCount} stale, ${approachingCount} approaching deadline, ${newDealsCount} new — ${formattedValue} pipeline`;

    return {
      title,
      description: [
        `Weekly Pipeline Digest for ${context.officeName ?? "office"}`,
        ``,
        `Stale Deals: ${staleCount} deals past their stage threshold`,
        `Approaching Deadline: ${approachingCount} deals with expected close date in the next 7 days`,
        `New This Week: ${newDealsCount} deals created in the past 7 days`,
        `Total Active Pipeline Value: ${formattedValue}`,
        ``,
        `Generated: ${generatedLabel}`,
      ].join("\n"),
      type: "system",
      assignedTo: assignment.assignedTo,
      officeId: context.officeId,
      originRule: weeklyPipelineDigestRuleId,
      sourceRule: weeklyPipelineDigestRuleId,
      sourceEvent: context.sourceEvent,
      dedupeKey: `office:${context.officeId}:assignee:${context.taskAssigneeId}:weekly_digest:${formatDate(context.now)}`,
      reasonCode: weeklyPipelineDigestRuleId,
      priority: "normal",
      priorityScore: 50,
      status: "pending",
      dueAt: context.now,
      entitySnapshot: {
        schemaVersion: 1,
        entityType: "office",
        entityId: context.entityId,
        officeId: context.officeId,
        officeName: context.officeName ?? null,
        sourceEvent: context.sourceEvent,
        staleCount,
        approachingCount,
        newDealsCount,
        pipelineValue,
        summary: title,
      },
      metadata: {
        entityId: context.entityId,
        officeId: context.officeId,
        officeName: context.officeName ?? null,
        staleCount,
        approachingCount,
        newDealsCount,
        pipelineValue,
        assignment: assignment.machineReason,
      },
    };
  },
};

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
  staleLeadRule,
  staleDealRule,
  inboundEmailReplyNeededRule,
  inboundEmailDisambiguationRule,
  contactOnboardingIntroEmailRule,
  contactOnboardingFollowUpCallRule,
  contactOnboardingCheckResponseRule,
  activityMeetingFollowUpRule,
  buildBidDeadlineRule(14, "Prepare final bid for", 40),
  buildBidDeadlineRule(7, "Confirm bid submission for", 65),
  buildBidDeadlineRule(1, "BID DUE TOMORROW", 90),
  coldLeadWarmingRule,
  dailyCloseDateFollowUpRule,
  dailyFirstOutreachTouchpointRule,
  dailyCadenceOverdueFollowUpRule,
  dealWonKickoffRule,
  dealWonWelcomePacketRule,
  dealWonIntroduceTeamRule,
  dealWonVerifyProcoreRule,
  dealWonCrossSellRule,
  dealLostCompetitorIntelRule,
  scopingEstimatingReviewRule,
  scopingServiceReviewRule,
  weeklyPipelineDigestRule,
];
