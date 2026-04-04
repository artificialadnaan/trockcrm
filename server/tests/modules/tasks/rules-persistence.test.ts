import { describe, expect, it, vi } from "vitest";
import { createTenantTaskRulePersistence } from "../../../src/modules/tasks/rules/persistence.js";

describe("tenant task rule persistence", () => {
  it("maps tenant rows for open tasks and resolution states", async () => {
    const queryMock = vi.fn(async (sql: string) => {
      if (sql.includes("FROM office_beta.tasks")) {
        return {
          rows: [
            {
              id: "task-1",
              title: "Follow up on deal 123",
              description: "Deal activity indicates a stale follow-up is needed.",
              type: "stale_deal",
              priority: "high",
              status: "pending",
              assigned_to: "user-1",
              created_by: null,
              office_id: "office-1",
              origin_rule: "stale_deal",
              source_rule: "stale_deal",
              source_event: "deal.updated",
              dedupe_key: "deal:123",
              reason_code: "stale_deal",
              entity_snapshot: { entityId: "deal:123", dealId: "123" },
              scheduled_for: null,
              waiting_on: null,
              blocked_by: null,
              started_at: null,
              deal_id: "123",
              contact_id: null,
              email_id: null,
              due_date: null,
              due_time: null,
              remind_at: null,
              completed_at: null,
              is_overdue: false,
              created_at: new Date("2026-04-01T10:00:00.000Z"),
              updated_at: new Date("2026-04-01T11:00:00.000Z"),
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.task_resolution_state")) {
        return {
          rows: [
            {
              origin_rule: "stale_deal",
              dedupe_key: "deal:123",
              resolution_status: "completed",
              resolved_at: new Date("2026-04-01T12:00:00.000Z"),
              suppressed_until: new Date("2026-05-01T12:00:00.000Z"),
            },
          ],
        };
      }

      return { rows: [] };
    });

    const persistence = createTenantTaskRulePersistence({ query: queryMock } as any, "office_beta");

    await expect(
      persistence.findOpenTaskByBusinessKey({
        originRule: "stale_deal",
        dedupeKey: "deal:123",
      })
    ).resolves.toMatchObject({
      id: "task-1",
      originRule: "stale_deal",
      sourceRule: "stale_deal",
      dedupeKey: "deal:123",
      entitySnapshot: { entityId: "deal:123", dealId: "123" },
    });

    await expect(
      persistence.findResolutionStateByBusinessKey({
        originRule: "stale_deal",
        dedupeKey: "deal:123",
      })
    ).resolves.toMatchObject({
      originRule: "stale_deal",
      dedupeKey: "deal:123",
      resolutionStatus: "completed",
    });
  });

  it("writes provenance and entity snapshots when upserting a task", async () => {
    const queryMock = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("INSERT INTO office_beta.tasks")) {
        return {
          rows: [
            {
              id: "task-2",
              title: params?.[0],
              description: params?.[1],
              type: params?.[2],
              priority: params?.[3],
              status: params?.[4],
              assigned_to: params?.[5],
              created_by: null,
              office_id: params?.[6],
              origin_rule: params?.[7],
              source_rule: params?.[8],
              source_event: params?.[9],
              dedupe_key: params?.[10],
              reason_code: params?.[11],
              entity_snapshot: params?.[12],
              deal_id: params?.[13],
              contact_id: params?.[14],
              email_id: params?.[15],
              scheduled_for: null,
              waiting_on: null,
              blocked_by: null,
              started_at: null,
              due_date: params?.[16],
              due_time: params?.[17],
              remind_at: params?.[18],
              completed_at: null,
              is_overdue: false,
              created_at: new Date("2026-04-04T15:00:00.000Z"),
              updated_at: new Date("2026-04-04T15:00:00.000Z"),
            },
          ],
        };
      }

      if (sql.startsWith("UPDATE office_beta.tasks")) {
        return {
          rows: [
            {
              id: "task-2",
              title: params?.[1],
              description: params?.[2],
              type: params?.[3],
              priority: params?.[4],
              status: params?.[5],
              assigned_to: params?.[6],
              created_by: null,
              office_id: params?.[7],
              origin_rule: params?.[8],
              source_rule: params?.[9],
              source_event: params?.[10],
              dedupe_key: params?.[11],
              reason_code: params?.[12],
              entity_snapshot: params?.[13],
              deal_id: params?.[14],
              contact_id: params?.[15],
              email_id: params?.[16],
              scheduled_for: null,
              waiting_on: null,
              blocked_by: null,
              started_at: null,
              due_date: params?.[17],
              due_time: params?.[18],
              remind_at: params?.[19],
              completed_at: null,
              is_overdue: false,
              created_at: new Date("2026-04-04T15:00:00.000Z"),
              updated_at: new Date("2026-04-04T16:00:00.000Z"),
            },
          ],
        };
      }

      return { rows: [] };
    });

    const persistence = createTenantTaskRulePersistence({ query: queryMock } as any, "office_beta");

    const created = await persistence.insertTask({
      title: "Follow up on deal 123",
      description: "Deal activity indicates a stale follow-up is needed.",
      type: "stale_deal",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "stale_deal",
      sourceRule: "stale_deal",
      sourceEvent: "deal.updated",
      dedupeKey: "deal:123",
      reasonCode: "stale_deal",
      priority: "high",
      priorityScore: 80,
      status: "pending",
      entitySnapshot: { entityId: "deal:123", officeId: "office-1" },
    });

    expect(created).toMatchObject({
      id: "task-2",
      originRule: "stale_deal",
      sourceRule: "stale_deal",
      dedupeKey: "deal:123",
      reasonCode: "stale_deal",
      entitySnapshot: { entityId: "deal:123", officeId: "office-1" },
    });

    const updated = await persistence.updateTask("task-2", {
      title: "Follow up on deal 123",
      description: "Deal activity indicates a stale follow-up is needed.",
      type: "stale_deal",
      assignedTo: "user-2",
      officeId: "office-1",
      originRule: "stale_deal",
      sourceRule: "stale_deal",
      sourceEvent: "deal.updated",
      dedupeKey: "deal:123",
      reasonCode: "stale_deal",
      priority: "high",
      priorityScore: 80,
      status: "pending",
      entitySnapshot: { entityId: "deal:123", officeId: "office-1" },
    });

    expect(updated).toMatchObject({
      id: "task-2",
      assignedTo: "user-2",
      sourceRule: "stale_deal",
      entitySnapshot: { entityId: "deal:123", officeId: "office-1" },
    });
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("updated_at = NOW()"))).toBe(true);
  });
});
