import { describe, expect, it } from "vitest";
import taskListPageSource from "./task-list-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("TaskListPage project context", () => {
  it("renders project context labels for deal-linked tasks", () => {
    const source = normalize(taskListPageSource);

    expect(source).toContain("function getTaskProjectContext");
    expect(source).toContain("task.dealNumber && task.dealName");
    expect(source).toContain("Project linked");
    expect(source).toContain("projectContext && (");
  });
});
