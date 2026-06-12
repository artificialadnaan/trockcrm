import { describe, expect, it } from "vitest";
import { breakdownLabel, BREAKDOWN_LABELS } from "./daily-summary-labels.js";
import { ACTIVITY_TYPES } from "./enums.js";

describe("breakdownLabel", () => {
  it("uses the singular at count 1 and plural otherwise (never '1 notes')", () => {
    expect(breakdownLabel("note", 1)).toBe("note");
    expect(breakdownLabel("note", 2)).toBe("notes");
    expect(breakdownLabel("moves", 1)).toBe("move");
    expect(breakdownLabel("edits", 1)).toBe("edit");
  });

  it("keeps 'created' invariant (past participle reads fine at any count)", () => {
    expect(breakdownLabel("created", 1)).toBe("created");
    expect(breakdownLabel("created", 5)).toBe("created");
  });

  it("labels multi-word activity types correctly (no 'task completeds' / '2 site visit')", () => {
    expect(breakdownLabel("task_completed", 1)).toBe("task completed");
    expect(breakdownLabel("task_completed", 3)).toBe("tasks completed");
    expect(breakdownLabel("site_visit", 1)).toBe("site visit");
    expect(breakdownLabel("site_visit", 2)).toBe("site visits");
    expect(breakdownLabel("follow_up", 2)).toBe("follow-ups");
    expect(breakdownLabel("lunch", 2)).toBe("lunches");
  });

  it("humanizes an unknown key instead of a naive '+s'", () => {
    expect(breakdownLabel("some_new_type", 2)).toBe("some new type");
  });

  it("covers EVERY ACTIVITY_TYPES value (so a real enum value never falls through to the invariant form)", () => {
    for (const t of ACTIVITY_TYPES) {
      expect(BREAKDOWN_LABELS[t], `missing label for activity type "${t}"`).toBeDefined();
    }
  });
});
