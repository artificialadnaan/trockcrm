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

/**
 * Resolves the office lookups.
 *
 * `slugByOfficeId` is keyed by office UUID so a test can make the RECIPIENT'S HOME office and the
 * office the EVENT happened in resolve to different schemas — the whole point of the cross-office
 * cases below. `homeOfficeId` is what public.users reports for the recipient.
 */
function mockOffices(
  slugByOfficeId: Record<string, string | null>,
  homeOfficeId: string | null = "office-1"
) {
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM public.users")) {
      return { rows: homeOfficeId === null ? [] : [{ office_id: homeOfficeId }] };
    }
    if (sql.includes("FROM public.offices")) {
      const slug = slugByOfficeId[String((params ?? [])[0])];
      return { rows: slug == null ? [] : [{ slug }] };
    }
    if (sql.includes("INSERT INTO")) return { rows: [{ id: "notif-1" }] };
    return { rows: [] };
  });
}

/** The common single-office arrangement: the event office and the home office are the same one. */
function mockOffice(slug: string | null) {
  mockOffices({ "office-1": slug }, "office-1");
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

  // Office context in the CRM is URL-driven: client/src/lib/api.ts reads ?officeId off the location
  // and turns it into the x-office-id header, and with no param the server falls back to the reader's
  // OWN active office. A bare link to a task in another office therefore resolves against the wrong
  // schema and 404s — the standing trap that used to send property-edit users home.
  it("carries the office so a cross-office link resolves against the right tenant", () => {
    expect(taskNotificationLink(TASK, "office-2")).toBe(`/tasks/${TASK}?officeId=office-2`);
  });

  it("encodes both the id and the office rather than pasting them in raw", () => {
    expect(taskNotificationLink("a/b?c")).toBe("/tasks/a%2Fb%3Fc");
    expect(taskNotificationLink(TASK, "a&b=c")).toBe(`/tasks/${TASK}?officeId=a%26b%3Dc`);
  });

  it("omits the param when the office is unknown, so a single-office link is unchanged", () => {
    expect(taskNotificationLink(TASK, null)).toBe(`/tasks/${TASK}`);
    expect(taskNotificationLink(TASK, undefined)).toBe(`/tasks/${TASK}`);
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
      // Office-qualified: see the taskNotificationLink cases above.
      `/tasks/${TASK}?officeId=office-1`,
    ]);
    expect(params[4]).not.toBe("/tasks");
  });

  // Same defect, and it PREDATES this feature — the handler was moved here verbatim from
  // jobs/index.ts, where it resolved the recipient's home office and ignored the event's officeId.
  // Both paths now share one resolver, so neither can drift back on its own.
  it("writes the assignment notification to the EVENT's office, not the assignee's home office", async () => {
    mockOffices({ "office-1": "dallas", "office-2": "atlanta" }, "office-1");

    await handleTaskAssignedEvent(
      { taskId: TASK, assignedTo: ASSIGNEE, title: "Send the roof photos" },
      "office-2"
    );

    expect(insertCall()![0]).toContain("office_atlanta.notifications");
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
    expect(params[4]).toBe(`/tasks/${TASK}?officeId=office-1`);
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

  // notifications.title is VARCHAR(500). Prefixing the replier onto a near-limit task title pushes the
  // composed string past it, Postgres rejects the INSERT, and because this runs inside a DURABLE job
  // the failure is not a lost bell row -- it burns the retry budget and eventually dead-letters, while
  // the comment and the email both already succeeded. A failure in the LEAST important of the three
  // channels consuming the budget that exists for the important ones.
  it("caps the composed title at the column width", async () => {
    mockOffice("dallas");

    await handleTaskRepliedEvent(
      {
        taskId: TASK,
        taskTitle: "T".repeat(600),
        assignerId: ASSIGNER,
        authorName: "Derek Barr",
        replyBody: "hi",
      },
      "office-1"
    );

    const title = String(insertCall()![1]![2]);
    expect(title.length).toBeLessThanOrEqual(500);
    // ...and it still says who replied, which is the part that carries the meaning.
    expect(title.startsWith("Derek Barr replied to: ")).toBe(true);
  });

  it("leaves a title that already fits completely alone", async () => {
    mockOffice("dallas");
    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "Send the roof photos", assignerId: ASSIGNER, authorName: "Derek Barr" },
      "office-1"
    );
    expect(insertCall()![1]![2]).toBe("Derek Barr replied to: Send the roof photos");
  });

  // The assignment side composes a title the same way and has the same ceiling.
  it("caps the assignment title too", async () => {
    mockOffice("dallas");
    await handleTaskAssignedEvent(
      { taskId: TASK, assignedTo: ASSIGNEE, title: "T".repeat(600) },
      "office-1"
    );
    const [, params] = insertCall()!;
    expect(String(params![2]).length).toBeLessThanOrEqual(500);
    // body is TEXT, not VARCHAR(500) -- it is not capped, and must not be truncated by accident.
    expect(String(params![3]).length).toBe(600);
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

  // ---------------------------------------------------------------------------------------------
  // THE TENANT THE ROW LANDS IN.
  //
  // `public.users` is GLOBAL while `notifications` and `tasks` are PER-OFFICE, so "the recipient's
  // home office" and "the office this task lives in" are two different questions that happen to have
  // the same answer in a single-office deployment. Resolving the schema from public.users.office_id
  // answers the wrong one: the row lands outside the tenant where notification reads happen and where
  // the linked task actually is, so the recipient never sees it — and a row is written into a schema
  // it does not belong to.
  //
  // The event carries the right answer. queue.ts:711 passes job.office_id into every handler, the
  // enqueuer sets it from the writer's ACTIVE office, and task.completed (task-completed.ts:79-88)
  // already resolves this way. These two handlers were the outliers.
  // ---------------------------------------------------------------------------------------------

  it("writes the reply notification to the EVENT's office, not the recipient's home office", async () => {
    // The recipient lives in office-1; the task and the reply are in office-2.
    mockOffices({ "office-1": "dallas", "office-2": "atlanta" }, "office-1");

    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "t", assignerId: ASSIGNER, replyBody: "hi" },
      "office-2"
    );

    const [sql] = insertCall()!;
    expect(sql).toContain("office_atlanta.notifications");
    expect(sql).not.toContain("office_dallas");
  });

  it("does not consult public.users at all when the event names its office", async () => {
    mockOffices({ "office-1": "dallas", "office-2": "atlanta" }, "office-1");

    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "t", assignerId: ASSIGNER, replyBody: "hi" },
      "office-2"
    );

    // A home-office lookup that still runs is a fallback waiting to be preferred again by accident.
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("FROM public.users"))
    ).toBe(false);
  });

  // The fallback stays, but strictly as a fallback: a domain_event row enqueued before office_id was
  // populated still has to deliver somewhere sane rather than silently dropping.
  it("falls back to the recipient's home office ONLY when the event names none", async () => {
    mockOffices({ "office-1": "dallas", "office-2": "atlanta" }, "office-1");

    await handleTaskRepliedEvent(
      { taskId: TASK, taskTitle: "t", assignerId: ASSIGNER, replyBody: "hi" },
      null
    );

    expect(insertCall()![0]).toContain("office_dallas.notifications");
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
