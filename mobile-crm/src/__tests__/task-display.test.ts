import { taskEffectiveDate, taskPriorityLabel, taskStatusLabel } from "../task-display";

describe("what a task row says beyond its title and date", () => {
  it("marks the priorities that change the decision", () => {
    expect(taskPriorityLabel("urgent")).toBe("Urgent");
    expect(taskPriorityLabel("high")).toBe("High");
    expect(taskPriorityLabel("low")).toBe("Low");
  });

  it("says nothing for the default priority", () => {
    // `normal` is what the server stamps on almost everything. A marker on every row distinguishes
    // none of them, which is the failure mode this whole module exists to avoid.
    expect(taskPriorityLabel("normal")).toBeNull();
  });

  it("marks a task that cannot be acted on yet", () => {
    // These share the dated sections with pending work, so without a marker a blocked task looks
    // exactly like one a rep should pick up next.
    expect(taskStatusLabel("in_progress")).toBe("In progress");
    expect(taskStatusLabel("waiting_on")).toBe("Waiting");
    expect(taskStatusLabel("blocked")).toBe("Blocked");
  });

  it("says nothing for the ordinary states", () => {
    // `pending` is the default. `scheduled` lives only in Later, which already says it — repeating it
    // on every row of that section is noise.
    expect(taskStatusLabel("pending")).toBeNull();
    expect(taskStatusLabel("scheduled")).toBeNull();
    expect(taskStatusLabel("completed")).toBeNull();
  });

  it("survives the shapes an API actually sends", () => {
    for (const fn of [taskPriorityLabel, taskStatusLabel]) {
      expect(fn(null)).toBeNull();
      expect(fn(undefined)).toBeNull();
      expect(fn("")).toBeNull();
      expect(fn("   ")).toBeNull();
      expect(fn("something_new_the_server_added")).toBeNull();
    }
  });

  it("reads a value whatever case or padding it arrives in", () => {
    expect(taskPriorityLabel(" URGENT ")).toBe("Urgent");
    expect(taskStatusLabel("Waiting_On")).toBe("Waiting");
  });

  it("never labels every row — the two defaults are both silent", () => {
    // The invariant. If a future edit makes `normal` or `pending` speak, every task grows a badge that
    // separates nothing, and the markers that DO matter stop standing out.
    expect(taskPriorityLabel("normal")).toBeNull();
    expect(taskStatusLabel("pending")).toBeNull();
  });
});

describe("which date a task actually happens on", () => {
  it("prefers scheduledFor for a scheduled task", () => {
    // The server clears dueDate on the move to scheduled, and the Later section is where these live.
    expect(taskEffectiveDate({ status: "scheduled", dueDate: null, scheduledFor: "2026-08-14" }))
      .toBe("2026-08-14");
  });

  it("prefers scheduledFor even when BOTH are set", () => {
    // The case a plain `dueDate ?? scheduledFor` got wrong. `updateTask` permits a due date on a row
    // that is still scheduled, so editing one in the web dialog leaves both populated — and the server
    // sorts by scheduled_for. Showing the due date put a row displaying one date in the position of
    // another, which reads as a broken sort rather than as a stale field.
    expect(taskEffectiveDate({ status: "scheduled", dueDate: "2026-08-01", scheduledFor: "2026-08-14" }))
      .toBe("2026-08-14");
  });

  it("prefers dueDate for everything that is not scheduled", () => {
    for (const status of ["pending", "in_progress", "waiting_on", "blocked", "completed"]) {
      expect(taskEffectiveDate({ status, dueDate: "2026-08-01", scheduledFor: "2026-08-14" }))
        .toBe("2026-08-01");
    }
  });

  it("falls back across the flip in both directions", () => {
    expect(taskEffectiveDate({ status: "scheduled", dueDate: "2026-08-01", scheduledFor: null }))
      .toBe("2026-08-01");
    expect(taskEffectiveDate({ status: "pending", dueDate: null, scheduledFor: "2026-08-14" }))
      .toBe("2026-08-14");
  });

  it("returns null rather than a fake date when the task has neither", () => {
    expect(taskEffectiveDate({ status: "pending", dueDate: null, scheduledFor: null })).toBeNull();
    expect(taskEffectiveDate({})).toBeNull();
  });

  it("reads the status whatever case it arrives in", () => {
    expect(taskEffectiveDate({ status: " Scheduled ", dueDate: "2026-08-01", scheduledFor: "2026-08-14" }))
      .toBe("2026-08-14");
  });
});
