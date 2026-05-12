/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportFilterBar, hydrateOwnerSelection, useReportFilters, type ReportFilters } from "./report-filter-bar";

const apiMock = vi.hoisted(() => vi.fn());

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

vi.mock("@/hooks/use-accessible-offices", () => ({
  useAccessibleOffices: () => ({
    offices: [
      { id: "office-dallas", name: "Dallas Office", slug: "dallas" },
      { id: "office-atlanta", name: "Atlanta Office", slug: "atlanta" },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

let container: HTMLDivElement;
let root: Root | null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  apiMock.mockReset();
});

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

function renderFilterBar(initialEntry = "/reports/operations/workflow-bottlenecks") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <ReportFilterBar />
      </MemoryRouter>,
    );
  });
  return container;
}

function changeSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function lastApiCallArgs() {
  return apiMock.mock.calls[apiMock.mock.calls.length - 1] ?? [];
}

function apiCallsMatching(predicate: (path: string, init: any) => boolean) {
  return apiMock.mock.calls.filter(([path, init]) => predicate(path as string, init));
}

describe("ReportFilterBar", () => {
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

  it("refetches sales reps scoped to the selected office", async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    const node = renderFilterBar();

    // Initial fetch with "all" office (no x-office-id header).
    await vi.waitFor(() => {
      const initial = apiCallsMatching((path, init) =>
        path === "/users/sales-reps" && !init?.headers,
      );
      expect(initial.length).toBeGreaterThan(0);
    });

    const officeSelect = Array.from(node.querySelectorAll<HTMLSelectElement>("select"))
      .find((select) => Array.from(select.options).some((option) => option.value === "dallas"));
    expect(officeSelect).toBeTruthy();

    act(() => {
      changeSelect(officeSelect!, "dallas");
    });

    await vi.waitFor(() => {
      const scoped = apiCallsMatching((path, init) =>
        path === "/users/sales-reps" && init?.headers?.["x-office-id"] === "office-dallas",
      );
      expect(scoped.length).toBeGreaterThan(0);
    });
  });

  it("resolves slug office filters to the canonical office UUID before fetching sales reps", async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    const node = renderFilterBar("/reports/operations/workflow-bottlenecks?office=dallas");

    // The API header uses the canonical office UUID resolved from the slug.
    await vi.waitFor(() => {
      const scoped = apiCallsMatching((path, init) =>
        path === "/users/sales-reps" && init?.headers?.["x-office-id"] === "office-dallas",
      );
      expect(scoped.length).toBeGreaterThan(0);
    });

    // The office <select> is slug-valued (matches the URL), so the select
    // shows "dallas" as its selected value. The canonical UUID is only used
    // for the API header (asserted above).
    const officeSelect = Array.from(node.querySelectorAll<HTMLSelectElement>("select"))
      .find((select) => Array.from(select.options).some((option) => option.value === "dallas"));
    expect(officeSelect?.value).toBe("dallas");
  });

  it("never emits an unscoped sales-reps fetch when the URL carries a legacy office slug", async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    renderFilterBar("/reports/operations/workflow-bottlenecks?office=dallas");

    // Wait long enough for any spurious unscoped fetch to land.
    await vi.waitFor(() => {
      const scoped = apiCallsMatching((path, init) =>
        path === "/users/sales-reps" && init?.headers?.["x-office-id"] === "office-dallas",
      );
      expect(scoped.length).toBeGreaterThan(0);
    });

    const unscoped = apiCallsMatching((path, init) =>
      path === "/users/sales-reps" && !init?.headers,
    );
    expect(unscoped.length).toBe(0);
    // ensure lastApiCallArgs is not unused
    expect(lastApiCallArgs().length).toBeGreaterThan(0);
  });
});
