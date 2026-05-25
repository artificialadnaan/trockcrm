import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "./projects-page.tsx"),
  "utf8",
);
const hookSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../hooks/use-projects.ts"),
  "utf8",
);

describe("projects page board wiring", () => {
  it("uses the board feed as the single Projects page data source", () => {
    expect(hookSource).toContain('api<PortfolioProjectBoardResponse>("/projects/board")');
    expect(hookSource).not.toContain("/projects/counts");
    expect(hookSource).not.toContain("/projects/by-phase");
  });

  it("renders clean empty-column states", () => {
    expect(pageSource).toContain("No projects in this stage.");
  });

  it("does not expose legacy list controls or mutation affordances", () => {
    expect(pageSource).not.toContain("setSearchParams");
    expect(pageSource).not.toContain("include_inactive");
    expect(pageSource).not.toContain("onDrag");
    expect(pageSource).not.toContain("method: \"POST\"");
    expect(pageSource).not.toContain("method: \"PATCH\"");
  });
});
