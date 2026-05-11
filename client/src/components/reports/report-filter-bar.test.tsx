/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportFilterBar } from "./report-filter-bar";

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
  container.remove();
  root = null;
  apiMock.mockReset();
});

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

describe("ReportFilterBar", () => {
  it("refetches sales reps scoped to the selected office", async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    const node = renderFilterBar();

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/users/sales-reps", undefined));

    const officeSelect = Array.from(node.querySelectorAll<HTMLSelectElement>("select"))
      .find((select) => Array.from(select.options).some((option) => option.value === "office-dallas"));
    expect(officeSelect).toBeTruthy();

    act(() => {
      changeSelect(officeSelect!, "office-dallas");
    });

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/users/sales-reps",
      { headers: { "x-office-id": "office-dallas" } },
    ));
  });

  it("resolves slug office filters to canonical office ids before fetching sales reps", async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    renderFilterBar("/reports/operations/workflow-bottlenecks?office=dallas");

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/users/sales-reps",
      { headers: { "x-office-id": "office-dallas" } },
    ));
  });
});
