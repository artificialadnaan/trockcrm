import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectsPageSource = fs.readFileSync(path.resolve(import.meta.dirname, "./projects-page.tsx"), "utf8");
const detailPageSource = fs.readFileSync(path.resolve(import.meta.dirname, "./project-detail-page.tsx"), "utf8");

describe("projects UI source", () => {
  it("loads the Procore mirror Kanban and paginated list APIs and the counts endpoint", () => {
    expect(projectsPageSource).toContain("api<{ phases: ProjectPhaseGroup[] }>(`/projects/by-phase?");
    expect(projectsPageSource).toContain("api<ProjectsListResponse>(`/projects?");
    expect(projectsPageSource).toContain("api<ProjectCounts>(`/projects/counts`)");
    expect(projectsPageSource).toContain("overflow-y-auto");
    expect(projectsPageSource).toMatch(/Project list/i);
  });

  it("provides an include-inactive toggle backed by URL state and propagates it to the API", () => {
    expect(projectsPageSource).toContain('searchParams.get("include_inactive")');
    expect(projectsPageSource).toContain('params.set("include_inactive", "true")');
    expect(projectsPageSource).toMatch(/aria-pressed=\{!includeInactive\}/);
    expect(projectsPageSource).toMatch(/aria-pressed=\{includeInactive\}/);
  });

  it("renders inactive projects with a distinct visual treatment in both kanban cards and the list", () => {
    // Inactive cards lose color emphasis; rows get a strike-through.
    expect(projectsPageSource).toContain("opacity-75");
    expect(projectsPageSource).toContain("line-through");
    expect(projectsPageSource).toMatch(/Inactive/);
    expect(projectsPageSource).toMatch(/Active/);
  });

  it("uses the bold uppercase header pattern shared with Leads and Deals", () => {
    expect(projectsPageSource).toContain('font-black uppercase');
    expect(projectsPageSource).toContain('tracking-[0.2em]');
    expect(projectsPageSource).toContain('text-brand-red');
    expect(projectsPageSource).toContain("MetricCard");
  });

  it("keeps the detail page display-only with expected tabs", () => {
    expect(detailPageSource).toContain('"overview" | "team" | "documents" | "phase-history" | "source-deal"');
    expect(detailPageSource).toContain("Display-only mirror");
    expect(detailPageSource).not.toContain("method: \"PATCH\"");
    expect(detailPageSource).not.toContain("method: \"POST\"");
  });
});
