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

  it("links the Sales Tier 1 and Operations Tier 3 report cards", () => {
    const html = renderReportsPage();

    expect(html).toContain('href="/reports/sales/pipeline-velocity"');
    expect(html).toContain('href="/reports/sales/closed-won-revenue"');
    expect(html).toContain('href="/reports/sales/lead-conversion"');
    expect(html).toContain("/reports/operations/workflow-bottlenecks");
    expect(html).toContain("/reports/operations/project-readiness");
    expect(html).toContain("/reports/operations/portfolio-load");
    expect(html).not.toContain("/reports/performance/director-scorecard");
    expect((html.match(/Coming soon/g) || [])).toHaveLength(6);
  });
});
