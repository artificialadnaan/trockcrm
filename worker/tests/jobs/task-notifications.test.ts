// In-app notifications for the task loop.
//
// Two things here are worth executing rather than reading. The first is the ENUM VALUE: the INSERT
// names 'task_replied', which is a Postgres enum value that did not exist until migration 0234. Before
// it, this statement raises `invalid input value for enum notification_type` and — because the throw
// is unhandled inside the job — takes the whole job with it. The second is the LINK: both types
// deep-link to the task, where `task_assigned` used to drop the recipient on the bare `/tasks` list
// and leave them to find the task they had just been told about.
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: { query: queryMock },
}));

const { handleTaskAssignedEvent, handleTaskRepliedEvent, taskNotificationLink } = await import(
  "../../src/jobs/task-notifications.js"
);

const ASSIGNEE = "user-assignee";
const ASSIGNER = "user-assigner";
const TASK = "3f0f9d1e-0000-4000-8000-00000000abcd";

/** Resolves the office lookups; everything else returns an empty result set. */
function mockOffice(slug: string | null) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM public.users")) return { rows: [{ office_id: "office-1" }] };
    if (sql.includes("FROM public.offices")) {
      return { rows: slug === null ? [] : [{ slug }] };
    }
    if (sql.includes("INSERT INTO")) return { rows: [{ id: "notif-1" }] };
    return { rows: [] };
  });
}

function insertCall() {
  return queryMock.mock.calls.find(
    ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO")
  );
}

function notifyCall() {
  return queryMock.mock.calls.find(
    ([sql]) => typeof sql === "string" && sql.includes("pg_notify")
  );
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("taskNotificationLink", () => {
  it("deep-links to the task", () => {
    expect(taskNotificationLink(TASK)).toBe(`/tasks/${TASK}`);
  });

  it("encodes the id rather than pasting it into the path raw", () => {
    expect(taskNotificationLink("a/b?c")).toBe("/tasks/a%2Fb%3Fc");
  });

  it("falls back to the list only when there is no task id at all", () => {
    expect(taskNotificationLink(null)).toBe("/tasks");
    expect(taskNotificationLink(undefined)).toBe("/tasks");
  });
});

describe("task.assigned", () => {
  it("writes a task_assigned row linked to the TASK, not the bare list", async () => {
    mockOffice("dallas");

    await handleTaskAssignedEvent(
      { taskId: TASK, assignedTo: ASSIGNEE, title: "Send the roof photos" },
      "office-1"
    );

    const [sql, params] = insertCall()!;
    expect(sql).toContain("office_dallas.notifications");
    expect(params).toEqual([
      ASSIGNEE,
      "task_assigned",
      "New task assigned: Send the roof photos",
      "Send the roof photos",
      `/tasks/${TASK}`,
    ]);
    expect(params[4]).not.toBe("/tasks");
  });

  it("does nothing when there is no assignee", async () => {
    mockOffice("dallas");
    await handleTaskAssignedEvent({ taskId: TASK, title: "x" }, "office-1");
    expect(insertCall()).toBeUndefined();
  });
});

describe("task.replied", () => {
  it("notifies the ASSIGNER — not the assignee — with the reply text", async () => {
    mockOffice("dallas");

    await handleTaskRepliedEvent(
      {
        taskId: TASK,
        taskTitle: "Send the roof photos",
        assignerId: ASSIGNER,
        authorId: ASSIGNEE,
        authorName: "Derek Barr",
        replyBody: "Photos are uploaded.",
      },
      "office-1"
    );

    const [sql, params] = insertCall()!;
    expect(sql).toContain("office_dallas.notifications");
    expect(params[0], "the recipient is the assigner").toBe(ASSIGNER);
    expect(params[1]).toBe("task_replied");
    expect(params[2]).toBe("Derek Barr replied to: Send the roof photos");
    expect(params[3]).toBe("Photos are uploaded.");
    expect(params[4]).toBe(`/tasks/${TASK}`);
  });

  it("pushes over PG NOTIFY so the SSE manager can pick it up", async () => {
    mockOffice("dallas");
    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "t", assignerId: ASSIGNER, replyBody: "hi" },
      "office-1"
    );

    const [, params] = notifyCall()!;
    expect(JSON.parse(String((params as unknown[])[0]))).toMatchObject({
      eventName: "notification.created",
      userId: ASSIGNER,
      notificationId: "notif-1",
    });
  });

  it("caps the body so the bell popover cannot render a wall of text", async () => {
    mockOffice("dallas");
    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "t", assignerId: ASSIGNER, replyBody: "x".repeat(2000) },
      "office-1"
    );
    expect(String(insertCall()![1]![3])).toHaveLength(500);
  });

  it("falls back to a neutral replier when no display name is recorded", async () => {
    mockOffice("dallas");
    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "Chase the permit", assignerId: ASSIGNER, authorName: "   " },
      "office-1"
    );
    expect(insertCall()![1]![2]).toBe("The assignee replied to: Chase the permit");
  });

  it("does nothing when the payload names no assigner", async () => {
    mockOffice("dallas");
    await handleTaskRepliedEvent({ taskId: TASK, taskTitle: "t" }, "office-1");
    expect(insertCall()).toBeUndefined();
  });

  it("does nothing when the office is inactive or unresolvable", async () => {
    mockOffice(null);
    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "t", assignerId: ASSIGNER, replyBody: "hi" },
      "office-1"
    );
    expect(insertCall()).toBeUndefined();
  });

  // The schema name cannot be a bind parameter, so it is interpolated — the slug regex is the only
  // thing standing between a malformed offices row and an injected statement.
  it("REFUSES a slug that is not a bare identifier", async () => {
    for (const slug of ["dallas; DROP TABLE users", "Dallas", "1dallas", "dallas-tx", ""]) {
      queryMock.mockReset();
      mockOffice(slug);
      await handleTaskRepliedEvent(
        { taskId: TASK, taskTitle: "t", assignerId: ASSIGNER, replyBody: "hi" },
        "office-1"
      );
      expect(insertCall(), slug).toBeUndefined();
    }
  });
});
