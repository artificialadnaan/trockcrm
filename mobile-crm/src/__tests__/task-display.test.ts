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

  it("marks a scheduled task, because its section does NOT imply it", () => {
    // The assumption I got wrong. `later` is far-future-or-undated open work UNION everything
    // scheduled, so the section mixes the two — a scheduled row was indistinguishable from an ordinary
    // one sitting months out. "Section implies status" only holds if the section is status-pure.
    expect(taskStatusLabel("scheduled")).toBe("Scheduled");
  });

  it("says nothing for the ordinary states", () => {
    // `pending` is the default the server stamps on almost everything.
    expect(taskStatusLabel("pending")).toBeNull();
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
      .toEqual({ value: "2026-08-14", source: "scheduledFor" });
  });

  it("prefers scheduledFor even when BOTH are set", () => {
    // The case a plain `dueDate ?? scheduledFor` got wrong. `updateTask` permits a due date on a row
    // that is still scheduled, so editing one in the web dialog leaves both populated — and the server
    // sorts by scheduled_for. Showing the due date put a row displaying one date in the position of
    // another, which reads as a broken sort rather than as a stale field.
    expect(taskEffectiveDate({ status: "scheduled", dueDate: "2026-08-01", scheduledFor: "2026-08-14" }))
      .toEqual({ value: "2026-08-14", source: "scheduledFor" });
  });

  it("prefers dueDate for everything that is not scheduled", () => {
    for (const status of ["pending", "in_progress", "waiting_on", "blocked", "completed"]) {
      expect(taskEffectiveDate({ status, dueDate: "2026-08-01", scheduledFor: "2026-08-14" }))
        .toEqual({ value: "2026-08-01", source: "dueDate" });
    }
  });

  it("falls back across the flip in both directions", () => {
    expect(taskEffectiveDate({ status: "scheduled", dueDate: "2026-08-01", scheduledFor: null }))
      .toEqual({ value: "2026-08-01", source: "dueDate" });
    expect(taskEffectiveDate({ status: "pending", dueDate: null, scheduledFor: "2026-08-14" }))
      .toEqual({ value: "2026-08-14", source: "scheduledFor" });
  });

  it("names the SOURCE, because the two columns are different types", () => {
    // `due_date` is a Postgres `date` — no time exists. `scheduled_for` is timestamptz and the web
    // dialog lets someone pick the hour, so the row has to format them differently. Keying on the
    // source rather than on the status is what makes an UNDATED task that fell back to scheduled_for
    // still show its time.
    expect(taskEffectiveDate({ status: "pending", dueDate: null, scheduledFor: "2026-08-14T15:00:00Z" }))
      .toEqual({ value: "2026-08-14T15:00:00Z", source: "scheduledFor" });
  });

  it("returns null rather than a fake date when the task has neither", () => {
    expect(taskEffectiveDate({ status: "pending", dueDate: null, scheduledFor: null }))
      .toEqual({ value: null, source: null });
    expect(taskEffectiveDate({})).toEqual({ value: null, source: null });
  });

  it("reads the status whatever case it arrives in", () => {
    expect(taskEffectiveDate({ status: " Scheduled ", dueDate: "2026-08-01", scheduledFor: "2026-08-14" }))
      .toEqual({ value: "2026-08-14", source: "scheduledFor" });
  });
});
