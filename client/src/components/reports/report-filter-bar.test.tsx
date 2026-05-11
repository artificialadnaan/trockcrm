import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { hydrateOwnerSelection, useReportFilters, type ReportFilters } from "./report-filter-bar";

function baseFilters(overrides: Partial<ReportFilters> = {}): ReportFilters {
  return {
    range: "90",
    dateFrom: "2026-02-01",
    dateTo: "2026-05-01",
    office: "all",
    ownerIds: [],
    ownerNames: [],
    ownerEmails: [],
    ...overrides,
  };
}

function renderHookSnapshot(initialEntry: string) {
  let snapshot = "";
  function Snapshot() {
    const { query } = useReportFilters();
    snapshot = JSON.stringify(query);
    return <pre>{snapshot}</pre>;
  }
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Snapshot />
    </MemoryRouter>
  );
  return JSON.parse(snapshot) as ReturnType<typeof useReportFilters>["query"];
}

describe("report filter bar helpers", () => {
  it("hydrates ownerIds from URL search params instead of hardcoding an empty owner scope", () => {
    const query = renderHookSnapshot("/reports/operations/workflow-bottlenecks?ownerIds=rep-1,rep-2&dateFrom=2026-02-01&dateTo=2026-05-01");

    expect(query.ownerIds).toEqual(["rep-1", "rep-2"]);
  });

  it("selects duplicate-display-name owners by email before falling back to display name", () => {
    const hydrated = hydrateOwnerSelection(
      baseFilters({
        ownerNames: ["Jordan Rep"],
        ownerEmails: ["jordan.one@trock.test"],
      }),
      [
        { id: "rep-a", displayName: "Jordan Rep", email: "jordan.one@trock.test" },
        { id: "rep-b", displayName: "Jordan Rep", email: "jordan.two@trock.test" },
      ]
    );

    expect(hydrated.ownerIds).toEqual(["rep-a"]);
    expect(hydrated.ownerIds).not.toContain("rep-b");
  });
});
