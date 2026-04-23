import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, "../../App.tsx"), "utf8");
const projectsPageSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./projects-page.tsx"),
  "utf8",
);

describe("project routing", () => {
  it("registers the project detail route under AppShell", () => {
    expect(appSource).toContain('import { ProjectDetailPage } from "@/pages/projects/project-detail-page";');
    expect(appSource).toContain('<Route path="/projects/:id" element={<ProjectDetailPage />} />');
  });

  it("links project list rows to the project detail route", () => {
    expect(projectsPageSource).toContain('to={`/projects/${project.id}`');
    expect(projectsPageSource).not.toContain('to={`/deals/${project.id}`');
  });
});
