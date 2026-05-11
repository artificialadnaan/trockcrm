import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectsPageSource = fs.readFileSync(path.resolve(import.meta.dirname, "./projects-page.tsx"), "utf8");
const detailPageSource = fs.readFileSync(path.resolve(import.meta.dirname, "./project-detail-page.tsx"), "utf8");

describe("projects UI source", () => {
  it("loads the Procore mirror Kanban and paginated list APIs", () => {
    expect(projectsPageSource).toContain("api<{ phases: ProjectPhaseGroup[] }>(`/projects/by-phase?");
    expect(projectsPageSource).toContain("api<ProjectsListResponse>(`/projects?");
    expect(projectsPageSource).toContain("overflow-y-auto");
    expect(projectsPageSource).toContain("Project List");
  });

  it("keeps the detail page display-only with expected tabs", () => {
    expect(detailPageSource).toContain('"overview" | "team" | "documents" | "phase-history" | "source-deal"');
    expect(detailPageSource).toContain("Display-only mirror");
    expect(detailPageSource).not.toContain("method: \"PATCH\"");
    expect(detailPageSource).not.toContain("method: \"POST\"");
  });
});
