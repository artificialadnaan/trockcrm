import { describe, expect, it } from "vitest";
import source from "./task-create-dialog.tsx?raw";

function normalize(value: string) {
  return value.replace(/\s+/g, " ");
}

describe("TaskCreateDialog", () => {
  it("allows reps to load the assignee picker and submit cross-user assignments", () => {
    const normalized = normalize(source);

    expect(normalized).toContain('user?.role === "admin" || user?.role === "director" || user?.role === "rep"');
    expect(normalized).toContain('api<{ users: Assignee[] }>("/tasks/assignees")');
    expect(normalized).toContain('assignedTo: canAssign && assignedTo ? assignedTo : undefined');
    expect(normalized).toContain("Assign to teammate");
  });
});
