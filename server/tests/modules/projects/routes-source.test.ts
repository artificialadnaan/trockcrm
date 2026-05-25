import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routesSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../src/modules/projects/routes.ts"),
  "utf8",
);
const serviceSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../src/modules/projects/service.ts"),
  "utf8",
);

describe("portfolio project route wiring", () => {
  it("exposes the read-only board endpoint before the id route", () => {
    expect(routesSource).toMatch(/router\.get\("\/board"/);
    expect(routesSource.indexOf('router.get("/board"')).toBeLessThan(routesSource.indexOf('router.get("/:id"'));
    expect(routesSource).toContain("listPortfolioProjectBoard(req.tenantClient!)");
    expect(routesSource).not.toContain('router.post("/board"');
    expect(serviceSource).toContain("WHERE is_board_relevant = true");
  });

  it("serves the new Projects detail route from portfolio_projects while preserving legacy detail separately", () => {
    expect(routesSource).toMatch(/router\.get\("\/legacy\/:id"/);
    expect(routesSource).toContain("getPortfolioProjectDetail(req.tenantClient!, projectId)");
    expect(routesSource).toContain("getProjectDetail(req.tenantClient!, projectId)");
    expect(serviceSource).toContain("FROM portfolio_projects");
    expect(serviceSource).toContain("FROM portfolio_project_stage_entries");
  });
});
