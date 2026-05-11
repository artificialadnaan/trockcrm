import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./reports-page";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("ReportsPage", () => {
  it("renders the placeholder report library by category", () => {
    const html = normalize(renderToStaticMarkup(<MemoryRouter><ReportsPage /></MemoryRouter>));

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
    const html = normalize(renderToStaticMarkup(<MemoryRouter><ReportsPage /></MemoryRouter>));

    expect(html).not.toContain("Report Builder");
    expect(html).not.toContain("Saved Views");
    expect(html).not.toContain("CSV Export");
    expect(html).not.toContain("Run Report");
    expect(html).not.toContain("Execute");
  });
});
