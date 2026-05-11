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
    expect(html).toContain("Pipeline Velocity");
    expect(html).toContain("Director Scorecard");
    expect(html).toContain("Executive Trends");
  });

  it("does not render report execution or builder actions", () => {
    const html = renderReportsPage();

    expect(html).not.toContain("Report Builder");
    expect(html).not.toContain("Saved Views");
    expect(html).not.toContain("CSV Export");
    expect(html).not.toContain("Run Report");
    expect(html).not.toContain("Execute");
  });

  it("makes shipped Sales, Performance, Operations, and Analytics tier cards clickable", () => {
    const html = renderReportsPage();

    expect(html).toContain('href="/reports/sales/pipeline-velocity"');
    expect(html).toContain('href="/reports/sales/closed-won-revenue"');
    expect(html).toContain('href="/reports/sales/lead-conversion"');
    expect(html).toContain("/reports/performance/director-scorecard");
    expect(html).toContain("/reports/performance/rep-activity");
    expect(html).toContain("/reports/performance/forecast-accuracy");
    expect(html).toContain("/reports/operations/workflow-bottlenecks");
    expect(html).toContain("/reports/operations/project-readiness");
    expect(html).toContain("/reports/operations/portfolio-load");
    expect(html).toContain("/reports/analytics/market-mix");
    expect(html).toContain("/reports/analytics/customer-concentration");
    expect(html).toContain("/reports/analytics/executive-trends");
    expect(html).not.toContain("Coming soon");
  });
});
