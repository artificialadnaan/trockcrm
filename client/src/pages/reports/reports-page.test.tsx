import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./reports-page";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderReportsPage() {
  return normalize(renderToStaticMarkup(<MemoryRouter><ReportsPage /></MemoryRouter>));
}

describe("ReportsPage", () => {
  it("renders the placeholder report library by category", () => {
    const html = renderReportsPage();

    expect(html).toContain("Reports");
    expect(html).toContain("Sales");
    expect(html).toContain("Performance");
    expect(html).toContain("Operations");
    expect(html).toContain("Analytics");
    expect(html).toContain("Coming soon");
    expect(html).toContain("Pipeline Velocity");
    expect(html).toContain("Director Scorecard");
  });

  it("does not render report execution or builder actions", () => {
    const html = renderReportsPage();

    expect(html).not.toContain("Report Builder");
    expect(html).not.toContain("Saved Views");
    expect(html).not.toContain("CSV Export");
    expect(html).not.toContain("Run Report");
    expect(html).not.toContain("Execute");
  });

  it("makes only the Operations Tier 3 cards clickable", () => {
    const html = renderReportsPage();

    expect(html).toContain("/reports/operations/workflow-bottlenecks");
    expect(html).toContain("/reports/operations/project-readiness");
    expect(html).toContain("/reports/operations/portfolio-load");
    expect(html).not.toContain("/reports/sales/pipeline-velocity");
    expect(html).not.toContain("/reports/performance/director-scorecard");
  });
});
