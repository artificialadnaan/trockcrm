import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    query: queryMock,
  },
}));

const { handleTaskCompletedEvent } = await import("../../src/jobs/task-completed.js");

describe("task.completed worker handling", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("writes close-loop state into the event office schema with the configured suppression window", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-04T15:00:00.000Z");
    vi.setSystemTime(now);

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ slug: "beta" }] };
      }

      return { rows: [] };
    });

    try {
      await handleTaskCompletedEvent(
        {
          taskId: "task-1",
          title: "Follow up on stale deal",
          completedBy: "user-1",
          dealId: "deal-1",
          contactId: "contact-1",
          type: "stale_deal",
          originRule: "stale_deal",
          dedupeKey: "deal:1",
          reasonCode: "stale_deal",
          entitySnapshot: { dealId: "deal-1", contactId: "contact-1" },
          suppressionWindowDays: 30,
        },
        "office-2"
      );
    } finally {
      vi.useRealTimers();
    }

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      ["office-2"]
    );
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("public.users"))).toBe(false);

    const activityCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.activities")
    );
    expect(activityCall).toBeDefined();
    expect(activityCall?.[0]).toContain("responsible_user_id");
    expect(activityCall?.[0]).toContain("performed_by_user_id");
    expect(activityCall?.[0]).toContain("source_entity_type");
    expect(activityCall?.[0]).toContain("source_entity_id");
    expect(activityCall?.[1]).toEqual([
      "user-1",
      "user-1",
      "deal",
      "deal-1",
      "deal-1",
      "contact-1",
      "Completed: Follow up on stale deal",
    ]);

    const resolutionCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.task_resolution_state")
    );
    expect(resolutionCall).toBeDefined();

    const params = resolutionCall?.[1] as Array<unknown> | undefined;
    expect(params?.[0]).toBe("office-2");
    expect(params?.[1]).toBe("task-1");
    expect(params?.[2]).toBe("stale_deal");
    expect(params?.[3]).toBe("deal:1");
    expect(params?.[4]).toBe("stale_deal");
    expect(params?.[5]).toEqual(now);
    expect(params?.[6]).toEqual(new Date("2026-05-04T15:00:00.000Z"));
    expect(params?.[7]).toEqual({ dealId: "deal-1", contactId: "contact-1" });
  });
});
