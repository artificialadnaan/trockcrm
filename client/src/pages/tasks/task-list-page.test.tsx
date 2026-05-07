import { describe, expect, it } from "vitest";
import taskListPageSource from "./task-list-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("TaskListPage project context", () => {
  it("formats and renders project context for deal-linked tasks", () => {
    const source = normalize(taskListPageSource);

    expect(source).toContain("function getTaskProjectContext");
    expect(source).toContain("if (task.dealNumber && task.dealName) return `${task.dealNumber} - ${task.dealName}`;");
    expect(source).toContain("if (task.dealName) return task.dealName;");
    expect(source).toContain("if (task.dealNumber) return task.dealNumber;");
    expect(source).toContain("return \"Project linked\";");
    expect(source).toContain("const projectContext = getTaskProjectContext(task);");
    expect(source).toContain("{projectContext ? <span className=\"truncate\">{projectContext}</span> : null}");
    expect(source).toContain("type GroupKey = \"overdue\" | \"today\" | \"this_week\" | \"later\" | \"completed\";");
    expect(source).toContain("getTaskStatusLabel(task.status)");
  });
});
