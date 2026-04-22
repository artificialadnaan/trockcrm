import { describe, expect, it } from "vitest";
import projectTasksTabSource from "./project-tasks-tab.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("ProjectTasksTab", () => {
  it("wires project-scoped creation and assignee task parity copy", () => {
    const source = normalize(projectTasksTabSource);

    expect(source).toContain("useProjectTasks(projectId)");
    expect(source).toContain("projectScopedProjectId={projectId}");
    expect(source).toContain("Assigned users will also see these tasks in their main Tasks page.");
    expect(source).toContain("const canEditTask = canManage || task.assignedTo === user?.id;");
    expect(source).toContain("<TaskEditDialog");
  });
});
