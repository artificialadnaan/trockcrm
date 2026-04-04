import { describe, expect, it } from "vitest";
import { evaluateTaskRules } from "../../../src/modules/tasks/rules/evaluator.js";
import { assignTaskFromContext } from "../../../src/modules/tasks/rules/assignment.js";
import { scoreTaskPriority, mapTaskPriorityBand } from "../../../src/modules/tasks/rules/priority.js";
import { TASK_RULES } from "../../../src/modules/tasks/rules/config.js";
import type {
  TaskRuleContext,
  TaskRecord,
  TaskResolutionStateRecord,
  TaskRulePersistence,
  TaskRuleDefinition,
} from "../../../src/modules/tasks/rules/types.js";

function createInMemoryStore(
  initialTasks: Array<TaskRecord> = [],
  resolutionStates: Array<TaskResolutionStateRecord> = []
) {
  const tasks = new Map<string, Map<string, TaskRecord>>();
  const resolutions = new Map<string, TaskResolutionStateRecord>();
  const operations: Array<"insert" | "update"> = [];
  let sequence = initialTasks.length + 1;

  const getTask = (originRule: string, dedupeKey: string) => {
    return tasks.get(originRule)?.get(dedupeKey) ?? null;
  };

  const setTask = (task: TaskRecord) => {
    const byOrigin = tasks.get(task.originRule) ?? new Map<string, TaskRecord>();
    byOrigin.set(task.dedupeKey, task);
    tasks.set(task.originRule, byOrigin);
  };

  for (const task of initialTasks) {
    setTask(task);
  }
  for (const state of resolutionStates) {
    resolutions.set(`${state.originRule}|${state.dedupeKey}`, state);
  }

  const persistence: TaskRulePersistence = {
    async findOpenTaskByBusinessKey({ originRule, dedupeKey }) {
      return getTask(originRule, dedupeKey);
    },
    async findResolutionStateByBusinessKey({ originRule, dedupeKey }: { originRule: string; dedupeKey: string }) {
      return resolutions.get(`${originRule}|${dedupeKey}`) ?? null;
    },
    async insertTask(draft) {
      operations.push("insert");
      const record = {
        ...draft,
        id: `task-${sequence++}`,
        status: draft.status ?? "pending",
      };
      setTask(record);
      return record;
    },
    async updateTask(taskId, draft) {
      operations.push("update");
      const existing = [...tasks.values()].flatMap((byOrigin) => [...byOrigin.values()]).find((task) => task.id === taskId);
      if (!existing) throw new Error("task not found");
      const record = {
        ...existing,
        ...draft,
        id: taskId,
      };
      setTask(record);
      return record;
    },
  };

  return {
    persistence,
    tasks,
    resolutions,
    operations,
    countTasks() {
      return [...tasks.values()].reduce((count, byOrigin) => count + byOrigin.size, 0);
    },
    getTask(originRule: string, dedupeKey: string) {
      return getTask(originRule, dedupeKey);
    },
  };
}

function makeContext(overrides: Partial<TaskRuleContext> = {}): TaskRuleContext {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "deal:123",
    sourceEvent: "deal.updated",
    dealId: "123",
    dealOwnerId: "user-owner",
    contactLinkedRepId: "user-contact",
    recentActorId: "user-actor",
    officeFallbackId: "user-office",
    priority: {
      dueProximity: 25,
      stageRisk: 25,
      staleAge: 20,
      unreadInbound: 15,
      dealValue: 15,
    },
    ...overrides,
  };
}

describe("task rule evaluator", () => {
  it("upserts one open task per origin_rule and dedupe_key", async () => {
    const store = createInMemoryStore();
    const context = makeContext();

    await evaluateTaskRules(context, store.persistence, TASK_RULES);
    await evaluateTaskRules(context, store.persistence, TASK_RULES);

    expect(store.countTasks()).toBe(1);
    expect(store.operations).toEqual(["insert", "update"]);
    expect(await store.persistence.findOpenTaskByBusinessKey({
      originRule: "stale_deal",
      dedupeKey: "deal:123",
    })).not.toBeNull();
  });

  it("skips regeneration when a completed resolution state exists for the same business key", async () => {
    const store = createInMemoryStore([], [
      {
        originRule: "stale_deal",
        dedupeKey: "deal:123",
        resolutionStatus: "completed",
        resolvedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    const context = makeContext();

    const outcomes = await evaluateTaskRules(context, store.persistence, TASK_RULES);

    expect(store.countTasks()).toBe(0);
    expect(outcomes).toContainEqual({
      ruleId: "stale_deal",
      businessKey: { originRule: "stale_deal", dedupeKey: "deal:123" },
      action: "skipped",
      reason: {
        code: "resolution_state_suppressed",
        detail: "stale_deal|deal:123",
      },
    });
  });

  it("allows regeneration once the suppression window has expired", async () => {
    const store = createInMemoryStore([], [
      {
        originRule: "stale_deal",
        dedupeKey: "deal:123",
        resolutionStatus: "completed",
        resolvedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    const context = makeContext();

    const outcomes = await evaluateTaskRules(context, store.persistence, TASK_RULES);

    expect(store.countTasks()).toBe(1);
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        ruleId: "stale_deal",
        businessKey: { originRule: "stale_deal", dedupeKey: "deal:123" },
        action: "created",
      })
    );
  });

  it("skips persistence when assignment resolves to no candidate", async () => {
    const store = createInMemoryStore();
    const context = makeContext({
      manualOverrideId: null,
      dealOwnerId: null,
      contactLinkedRepId: null,
      recentActorId: null,
      officeFallbackId: null,
    });

    const outcomes = await evaluateTaskRules(context, store.persistence, TASK_RULES);

    expect(store.countTasks()).toBe(0);
    expect(outcomes).toContainEqual({
      ruleId: "stale_deal",
      businessKey: { originRule: "stale_deal", dedupeKey: "deal:123" },
      action: "skipped",
      reason: { code: "no_assignment_candidate", detail: "stale_deal" },
    });
  });

  it("preserves an existing open task status when refreshing a rule match", async () => {
    const existing: TaskRecord = {
      id: "task-1",
      title: "Follow up on deal 123",
      description: "Deal activity indicates a stale follow-up is needed.",
      type: "stale_deal",
      assignedTo: "user-owner",
      officeId: "office-1",
      originRule: "stale_deal",
      sourceEvent: "deal.updated",
      dedupeKey: "deal:123",
      reasonCode: "stale_deal",
      priority: "high",
      priorityScore: 80,
      status: "blocked",
      metadata: {},
    };
    const store = createInMemoryStore([existing]);
    const context = makeContext();

    const outcomes = await evaluateTaskRules(context, store.persistence, TASK_RULES);
    const refreshed = store.getTask("stale_deal", "deal:123");

    expect(outcomes).toContainEqual({
      ruleId: "stale_deal",
      businessKey: { originRule: "stale_deal", dedupeKey: "deal:123" },
      action: "updated",
      taskId: "task-1",
    });
    expect(refreshed?.status).toBe("blocked");
  });

  it("keeps collision-prone dedupe keys distinct within a single evaluation pass", async () => {
    const store = createInMemoryStore();
    const collisionRules: TaskRuleDefinition[] = [
      {
        id: "a:b",
        sourceEvent: "deal.updated",
        reasonCode: "rule-a",
        suppressionWindowDays: 30,
        buildDedupeKey() {
          return "c";
        },
        async buildTask() {
          return {
            title: "Rule A",
            type: "manual",
            assignedTo: "user-a",
            officeId: "office-1",
            originRule: "a:b",
            sourceEvent: "deal.updated",
            dedupeKey: "c",
            reasonCode: "rule-a",
            priority: "normal",
            priorityScore: 50,
            status: "pending",
          };
        },
      },
      {
        id: "a",
        sourceEvent: "deal.updated",
        reasonCode: "rule-b",
        suppressionWindowDays: 30,
        buildDedupeKey() {
          return "b:c";
        },
        async buildTask() {
          return {
            title: "Rule B",
            type: "manual",
            assignedTo: "user-b",
            officeId: "office-1",
            originRule: "a",
            sourceEvent: "deal.updated",
            dedupeKey: "b:c",
            reasonCode: "rule-b",
            priority: "normal",
            priorityScore: 50,
            status: "pending",
          };
        },
      },
    ];

    const context = makeContext();
    const outcomes = await evaluateTaskRules(context, store.persistence, collisionRules);

    expect(store.countTasks()).toBe(2);
    expect(outcomes).toContainEqual({
      ruleId: "a:b",
      businessKey: { originRule: "a:b", dedupeKey: "c" },
      action: "created",
      taskId: "task-1",
    });
    expect(outcomes).toContainEqual({
      ruleId: "a",
      businessKey: { originRule: "a", dedupeKey: "b:c" },
      action: "created",
      taskId: "task-2",
    });
  });

  it("assigns by manual override before deal owner, contact-linked rep, recent actor, and office fallback", async () => {
    const result = await assignTaskFromContext({
      entityId: "deal:123",
      manualOverrideId: "user-manual",
      dealOwnerId: "user-owner",
      contactLinkedRepId: "user-contact",
      recentActorId: "user-actor",
      officeFallbackId: "user-office",
    });

    expect(result.assignedTo).toBe("user-manual");
    expect(result.machineReason.code).toBe("manual_override");
  });

  it("falls back to the deal owner when manual override is absent", async () => {
    const result = await assignTaskFromContext({
      entityId: "deal:123",
      manualOverrideId: null,
      dealOwnerId: "user-owner",
      contactLinkedRepId: "user-contact",
      recentActorId: "user-actor",
      officeFallbackId: "user-office",
    });

    expect(result.assignedTo).toBe("user-owner");
    expect(result.machineReason.code).toBe("deal_owner");
  });

  it("maps combined priority inputs into a score and band", () => {
    const score = scoreTaskPriority({
      dueProximity: 30,
      stageRisk: 20,
      staleAge: 10,
      unreadInbound: 10,
      dealValue: 20,
    });

    expect(score.score).toBe(90);
    expect(score.band).toBe("urgent");
    expect(mapTaskPriorityBand(64)).toBe("high");
    expect(mapTaskPriorityBand(39)).toBe("normal");
    expect(mapTaskPriorityBand(10)).toBe("low");
  });

  it("creates a reply-needed inbound email task for a clearly associated deal", async () => {
    const store = createInMemoryStore();
    const context = makeContext({
      sourceEvent: "email.received",
      entityId: "email:email-1",
      dealId: "deal-1",
      contactId: "contact-1",
      emailId: "email-1",
      taskAssigneeId: "user-mailbox",
      contactName: "Casey Customer",
      emailSubject: "Need an updated proposal",
      activeDealCount: 1,
      activeDealNames: ["D-1001 Alpha Roof"],
      unreadInbound: 30,
    });

    const outcomes = await evaluateTaskRules(context, store.persistence, TASK_RULES);
    const replyTask = store.getTask("inbound_email_reply_needed", "email:email-1:reply_needed");

    expect(outcomes).toContainEqual({
      ruleId: "inbound_email_reply_needed",
      businessKey: {
        originRule: "inbound_email_reply_needed",
        dedupeKey: "email:email-1:reply_needed",
      },
      action: "created",
      taskId: replyTask?.id,
    });
    expect(replyTask).toEqual(
      expect.objectContaining({
        title: "Reply to Casey Customer: Need an updated proposal",
        type: "inbound_email",
        assignedTo: "user-mailbox",
        reasonCode: "reply_needed",
      })
    );
  });

  it("creates a disambiguation inbound email task when multiple active deals match", async () => {
    const store = createInMemoryStore();
    const context = makeContext({
      sourceEvent: "email.received",
      entityId: "email:email-2",
      contactId: "contact-2",
      emailId: "email-2",
      taskAssigneeId: "user-mailbox",
      contactName: "Taylor Customer",
      emailSubject: "Question about my project",
      activeDealCount: 2,
      activeDealNames: ["D-1001 Alpha Roof", "D-1002 Beta Roof"],
      unreadInbound: 20,
      dealId: null,
    });

    const outcomes = await evaluateTaskRules(context, store.persistence, TASK_RULES);
    const disambiguationTask = store.getTask(
      "inbound_email_deal_disambiguation",
      "email:email-2:deal_disambiguation"
    );

    expect(outcomes).toContainEqual({
      ruleId: "inbound_email_deal_disambiguation",
      businessKey: {
        originRule: "inbound_email_deal_disambiguation",
        dedupeKey: "email:email-2:deal_disambiguation",
      },
      action: "created",
      taskId: disambiguationTask?.id,
    });
    expect(disambiguationTask).toEqual(
      expect.objectContaining({
        title: "Associate email to correct deal",
        type: "inbound_email",
        assignedTo: "user-mailbox",
        reasonCode: "deal_disambiguation",
      })
    );
  });
});
