import { describe, expect, it } from "vitest";
import { evaluateTaskRules } from "../../../src/modules/tasks/rules/evaluator.js";
import { TASK_RULES } from "../../../src/modules/tasks/rules/config.js";
import { dismissResolvedStaleLeadTasks } from "../../../../worker/src/jobs/daily-tasks.js";
import type {
  TaskRecord,
  TaskResolutionStateRecord,
  TaskRuleContext,
  TaskRulePersistence,
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
    async findResolutionStateByBusinessKey({ originRule, dedupeKey }) {
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
      const existing = [...tasks.values()]
        .flatMap((byOrigin) => [...byOrigin.values()])
        .find((task) => task.id === taskId);

      if (!existing) throw new Error("task not found");

      const record = {
        ...existing,
        ...draft,
        id: taskId,
      };
      setTask(record);
      return record;
    },
    async dismissTaskByBusinessKey({ originRule, dedupeKey }, resolution) {
      const existing = getTask(originRule, dedupeKey);
      if (!existing) return null;

      const record = {
        ...existing,
        status: "dismissed" as const,
        completedAt: resolution.resolvedAt ?? new Date(),
      };
      setTask(record);
      resolutions.set(`${originRule}|${dedupeKey}`, {
        originRule,
        dedupeKey,
        resolutionStatus: resolution.resolutionStatus,
        resolvedAt: resolution.resolvedAt ?? null,
        suppressedUntil: resolution.suppressedUntil ?? null,
      });
      return record;
    },
  };

  return {
    operations,
    persistence,
    getTask,
    countTasks() {
      return [...tasks.values()].reduce((count, byOrigin) => count + byOrigin.size, 0);
    },
  };
}

function makeContext(overrides: Partial<TaskRuleContext> = {}): TaskRuleContext {
  return {
    now: new Date("2026-04-15T13:00:00.000Z"),
    officeId: "office-1",
    entityId: "lead:lead-123",
    sourceEvent: "cron.daily_task_generation.stale_lead",
    dealOwnerId: null,
    taskAssigneeId: "rep-9",
    contactLinkedRepId: null,
    recentActorId: null,
    officeFallbackId: null,
    staleAge: 17,
    stage: "Qualified",
    contactName: "Acme HQ",
    ...overrides,
  };
}

describe("stale lead task rule", () => {
  it("builds a stale lead follow-up task through the shared evaluator", async () => {
    const store = createInMemoryStore();

    const outcomes = await evaluateTaskRules(
      makeContext({
        leadId: "lead-123",
        leadName: "Acme HQ lobby remodel",
      }),
      store.persistence,
      TASK_RULES
    );

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        ruleId: "stale_lead",
        businessKey: { originRule: "stale_lead", dedupeKey: "lead:lead-123" },
        action: "created",
      })
    );

    expect(store.getTask("stale_lead", "lead:lead-123")).toMatchObject({
      title: "Re-engage stale lead Acme HQ lobby remodel",
      description: 'Lead "Acme HQ lobby remodel" has been in Qualified for 17 days without progression.',
      type: "follow_up",
      assignedTo: "rep-9",
      originRule: "stale_lead",
      sourceEvent: "cron.daily_task_generation.stale_lead",
      dedupeKey: "lead:lead-123",
      reasonCode: "stale_lead",
      status: "pending",
    });
  });

  it("suppresses duplicate stale lead generation by updating the same business key", async () => {
    const store = createInMemoryStore();
    const context = makeContext({
      leadId: "lead-123",
      leadName: "Acme HQ lobby remodel",
    });

    await evaluateTaskRules(context, store.persistence, TASK_RULES);
    await evaluateTaskRules(context, store.persistence, TASK_RULES);

    expect(store.countTasks()).toBe(1);
    expect(store.operations).toEqual(["insert", "update"]);
    expect(store.getTask("stale_lead", "lead:lead-123")).not.toBeNull();
  });

  it("preserves manual reassignment when refreshing an existing stale lead task", async () => {
    const store = createInMemoryStore([
      {
        id: "task-1",
        title: "Re-engage stale lead Acme HQ lobby remodel",
        description: 'Lead "Acme HQ lobby remodel" has been in Qualified for 17 days without progression.',
        type: "follow_up",
        assignedTo: "director-override",
        officeId: "office-1",
        originRule: "stale_lead",
        sourceEvent: "cron.daily_task_generation.stale_lead",
        dedupeKey: "lead:lead-123",
        reasonCode: "stale_lead",
        priority: "normal",
        priorityScore: 69,
        status: "pending",
        metadata: {},
      } as TaskRecord,
    ]);

    await evaluateTaskRules(
      makeContext({
        leadId: "lead-123",
        leadName: "Acme HQ lobby remodel",
        taskAssigneeId: "rep-9",
      }),
      store.persistence,
      TASK_RULES
    );

    expect(store.getTask("stale_lead", "lead:lead-123")?.assignedTo).toBe("director-override");
  });

  it("dismisses stale lead tasks that are no longer stale", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (queries.length === 1) {
          return {
            rowCount: 2,
            rows: [
              {
                id: "task-1",
                origin_rule: "stale_lead",
                dedupe_key: "lead:lead-2",
                reason_code: "stale_lead",
                entity_snapshot: { leadId: "lead-2" },
              },
              {
                id: "task-2",
                origin_rule: "stale_lead",
                dedupe_key: "lead:lead-3",
                reason_code: "stale_lead",
                entity_snapshot: { leadId: "lead-3" },
              },
            ],
          };
        }
        return { rowCount: 2, rows: [] };
      },
    };

    const dismissed = await dismissResolvedStaleLeadTasks(
      client as any,
      "office_beta",
      "office-1",
      ["lead-1"]
    );

    expect(dismissed).toBe(2);
    expect(queries[0]).toContain("UPDATE office_beta.tasks");
    expect(queries[0]).toContain("origin_rule = 'stale_lead'");
    expect(queries[0]).toContain("status = 'dismissed'");
    expect(queries[1]).toContain("INSERT INTO office_beta.task_resolution_state");
    expect(queries[1]).toContain("resolution_status");
  });
});
