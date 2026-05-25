import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectsPageSource = fs.readFileSync(path.resolve(import.meta.dirname, "./projects-page.tsx"), "utf8");
const detailPageSource = fs.readFileSync(path.resolve(import.meta.dirname, "./project-detail-page.tsx"), "utf8");

describe("projects UI source", () => {
  it("loads the portfolio board endpoint instead of the legacy Projects mirror APIs", () => {
    expect(projectsPageSource).toContain("usePortfolioProjectBoard");
    expect(projectsPageSource).not.toContain("/projects/by-phase");
    expect(projectsPageSource).not.toContain("/projects/counts");
    expect(projectsPageSource).not.toContain("include_inactive");
    expect(projectsPageSource).toContain("Projects kanban board");
  });

  it("keeps the board read-only with no drag/drop or mutation calls", () => {
    expect(projectsPageSource).not.toContain("draggable");
    expect(projectsPageSource).not.toContain("onDrag");
    expect(projectsPageSource).not.toContain("method: \"PATCH\"");
    expect(projectsPageSource).not.toContain("method: \"POST\"");
  });

  it("keeps cards lean with project name and project number only", () => {
    expect(projectsPageSource).toContain("project.projectNumber");
    expect(projectsPageSource).toContain("project.name");
    expect(projectsPageSource).not.toMatch(/amount|change order|DOA/i);
  });

  it("uses the bold uppercase header pattern shared with Leads and Deals", () => {
    expect(projectsPageSource).toContain('font-black uppercase');
    expect(projectsPageSource).toContain('tracking-[0.2em]');
    expect(projectsPageSource).toContain('text-brand-red');
  });

  it("keeps the detail page display-only with stage history", () => {
    expect(detailPageSource).toContain("Stage History");
    expect(detailPageSource).toContain("Project References");
    expect(detailPageSource).not.toContain("method: \"PATCH\"");
    expect(detailPageSource).not.toContain("method: \"POST\"");
  });
});
