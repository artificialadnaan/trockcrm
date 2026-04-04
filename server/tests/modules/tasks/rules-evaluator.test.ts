import { describe, expect, it } from "vitest";
import { evaluateTaskRules } from "../../../src/modules/tasks/rules/evaluator.js";
import { assignTaskFromContext } from "../../../src/modules/tasks/rules/assignment.js";
import { scoreTaskPriority, mapTaskPriorityBand } from "../../../src/modules/tasks/rules/priority.js";
import { TASK_RULES } from "../../../src/modules/tasks/rules/config.js";
import type {
  TaskRuleContext,
  TaskRulePersistence,
  SystemTaskDraft,
} from "../../../src/modules/tasks/rules/types.js";

function createInMemoryStore() {
  const tasks = new Map<string, SystemTaskDraft & { id: string; status: "pending" }>();
  const operations: Array<"insert" | "update"> = [];
  let sequence = 1;

  const persistence: TaskRulePersistence = {
    async findOpenTaskByBusinessKey({ originRule, dedupeKey }) {
      return tasks.get(`${originRule}:${dedupeKey}`) ?? null;
    },
    async insertTask(draft) {
      operations.push("insert");
      const record = {
        ...draft,
        id: `task-${sequence++}`,
        status: "pending" as const,
      };
      tasks.set(`${draft.originRule}:${draft.dedupeKey}`, record);
      return record;
    },
    async updateTask(taskId, draft) {
      operations.push("update");
      const existing = [...tasks.values()].find((task) => task.id === taskId);
      if (!existing) throw new Error("task not found");
      const record = {
        ...existing,
        ...draft,
        id: taskId,
      };
      tasks.set(`${draft.originRule}:${draft.dedupeKey}`, record);
      return record;
    },
  };

  return {
    persistence,
    tasks,
    operations,
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

    expect(store.tasks.size).toBe(1);
    expect(store.operations).toEqual(["insert", "update"]);
    expect(await store.persistence.findOpenTaskByBusinessKey({
      originRule: "stale_deal",
      dedupeKey: "deal:123",
    })).not.toBeNull();
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
});
