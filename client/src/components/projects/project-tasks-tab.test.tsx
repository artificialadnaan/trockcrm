import { describe, expect, it } from "vitest";
import projectTasksTabSource from "./project-tasks-tab.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("ProjectTasksTab", () => {
  it("keeps project-scoped task creation available to reps", () => {
    const source = normalize(projectTasksTabSource);

    expect(source).toContain('const canCreateProjectTasks = user?.role === "admin" || user?.role === "director" || user?.role === "rep";');
    expect(source).toContain('const canManageAllProjectTasks = user?.role === "admin" || user?.role === "director";');
    expect(source).toContain("projectScopedProjectId={projectId}");
    expect(source).toContain("Assigned users will also see these tasks in their main Tasks page.");
  });
});
