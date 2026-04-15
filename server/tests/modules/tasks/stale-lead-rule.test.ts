import { describe, expect, it } from "vitest";
import { evaluateTaskRules } from "../../../src/modules/tasks/rules/evaluator.js";
import { TASK_RULES } from "../../../src/modules/tasks/rules/config.js";
import { buildStaleLeadDedupeKey } from "../../../src/modules/tasks/rules/stale-lead-key.js";
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
    stageEnteredAt: "2026-03-29T12:00:00.000Z",
    contactName: "Acme HQ",
    ...overrides,
  };
}

describe("stale lead task rule", () => {
  it("builds a stale lead follow-up task through the shared evaluator", async () => {
    const store = createInMemoryStore();
    const dedupeKey = buildStaleLeadDedupeKey("lead-123", "2026-03-29T12:00:00.000Z");

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
        businessKey: { originRule: "stale_lead", dedupeKey },
        action: "created",
      })
    );

    expect(store.getTask("stale_lead", dedupeKey!)).toMatchObject({
      title: "Re-engage stale lead Acme HQ lobby remodel",
      description: 'Lead "Acme HQ lobby remodel" has been in Qualified for 17 days without progression.',
      type: "follow_up",
      assignedTo: "rep-9",
      originRule: "stale_lead",
      sourceEvent: "cron.daily_task_generation.stale_lead",
      dedupeKey,
      reasonCode: "stale_lead",
      status: "pending",
    });
  });

  it("suppresses duplicate stale lead generation by updating the same business key", async () => {
    const store = createInMemoryStore();
    const dedupeKey = buildStaleLeadDedupeKey("lead-123", "2026-03-29T12:00:00.000Z");
    const context = makeContext({
      leadId: "lead-123",
      leadName: "Acme HQ lobby remodel",
    });

    await evaluateTaskRules(context, store.persistence, TASK_RULES);
    await evaluateTaskRules(context, store.persistence, TASK_RULES);

    expect(store.countTasks()).toBe(1);
    expect(store.operations).toEqual(["insert", "update"]);
    expect(store.getTask("stale_lead", dedupeKey!)).not.toBeNull();
  });

  it("preserves manual reassignment when refreshing an existing stale lead task", async () => {
    const dedupeKey = buildStaleLeadDedupeKey("lead-123", "2026-03-29T12:00:00.000Z");
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
        dedupeKey: dedupeKey!,
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

    expect(store.getTask("stale_lead", dedupeKey!)?.assignedTo).toBe("director-override");
  });

  it("suppresses a manually dismissed stale lead task while the same stale episode remains active", async () => {
    const dedupeKey = buildStaleLeadDedupeKey("lead-123", "2026-03-29T12:00:00.000Z");
    const store = createInMemoryStore(
      [],
      [
        {
          originRule: "stale_lead",
          dedupeKey: dedupeKey!,
          resolutionStatus: "dismissed",
          resolvedAt: "2026-04-15T13:00:00.000Z",
          suppressedUntil: "2026-05-15T13:00:00.000Z",
        },
      ]
    );

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
        businessKey: { originRule: "stale_lead", dedupeKey },
        action: "skipped",
      })
    );
    expect(store.countTasks()).toBe(0);
  });

  it("allows a new stale episode after stage re-entry to create a new task key", async () => {
    const firstEpisodeKey = buildStaleLeadDedupeKey("lead-123", "2026-03-29T12:00:00.000Z");
    const secondEpisodeKey = buildStaleLeadDedupeKey("lead-123", "2026-04-20T09:30:00.000Z");
    const store = createInMemoryStore(
      [],
      [
        {
          originRule: "stale_lead",
          dedupeKey: firstEpisodeKey!,
          resolutionStatus: "dismissed",
          resolvedAt: "2026-04-15T13:00:00.000Z",
          suppressedUntil: "2026-05-15T13:00:00.000Z",
        },
      ]
    );

    const outcomes = await evaluateTaskRules(
      makeContext({
        now: new Date("2026-04-25T13:00:00.000Z"),
        leadId: "lead-123",
        leadName: "Acme HQ lobby remodel",
        stageEnteredAt: "2026-04-20T09:30:00.000Z",
      }),
      store.persistence,
      TASK_RULES
    );

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        businessKey: { originRule: "stale_lead", dedupeKey: secondEpisodeKey },
        action: "created",
      })
    );
    expect(store.getTask("stale_lead", secondEpisodeKey!)).not.toBeNull();
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
                dedupe_key: "lead:lead-2:stage_entered:2026-03-10T00:00:00.000Z",
                reason_code: "stale_lead",
                entity_snapshot: { leadId: "lead-2" },
              },
              {
                id: "task-2",
                origin_rule: "stale_lead",
                dedupe_key: "lead:lead-3:stage_entered:2026-03-12T00:00:00.000Z",
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
      [buildStaleLeadDedupeKey("lead-1", "2026-04-01T00:00:00.000Z")!]
    );

    expect(dismissed).toBe(2);
    expect(queries[0]).toContain("UPDATE office_beta.tasks");
    expect(queries[0]).toContain("origin_rule = 'stale_lead'");
    expect(queries[0]).toContain("status = 'dismissed'");
    expect(queries[1]).toContain("INSERT INTO office_beta.task_resolution_state");
    expect(queries[1]).toContain("resolution_status");
  });
});
