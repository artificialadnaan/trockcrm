import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const releaseMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: async () => ({
      query: queryMock,
      release: releaseMock,
    }),
  },
}));

const { runActivityDropDetection } = await import("../../src/jobs/activity-alerts.js");

describe("activity alerts worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  it("uses responsible activity ownership in baseline and recent activity queries", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql.includes("FROM public.users") && sql.includes("role = 'rep'")) {
        return { rows: [{ id: "rep-1", display_name: "Alice" }] };
      }

      if (sql.includes("AVG(activity_count)")) {
        return {
          rows: [{ avg_weekly: "10.00", stddev_weekly: "1.00", weeks_with_data: "13" }],
        };
      }

      if (sql.includes("recent_count")) {
        return { rows: [{ recent_count: 3 }] };
      }

      if (sql.includes("FROM office_beta.notifications") && sql.includes("activity_drop")) {
        return { rows: [] };
      }

      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }] };
      }

      if (sql.startsWith("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notif-1" }] };
      }

      return { rows: [] };
    });

    await runActivityDropDetection();

    const activityQueries = queryMock.mock.calls
      .map(([sql]) => sql)
      .filter((sql): sql is string => typeof sql === "string" && sql.includes("office_beta.activities"));

    expect(activityQueries).toHaveLength(2);
    expect(activityQueries[0]).toContain("a.responsible_user_id = $1");
    expect(activityQueries[0]).not.toContain("a.user_id = $1");
    expect(activityQueries[1]).toContain("WHERE responsible_user_id = $1");
    expect(activityQueries[1]).not.toContain("WHERE user_id = $1");
    expect(releaseMock).toHaveBeenCalled();
  });

  it("rolls back the office transaction when an office query fails", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql.includes("role = 'rep'")) {
        throw new Error("boom");
      }

      return { rows: [] };
    });

    await expect(runActivityDropDetection()).rejects.toThrow("boom");

    expect(queryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(releaseMock).toHaveBeenCalled();
  });
});
