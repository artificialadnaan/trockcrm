// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFilterState } from "./use-filter-state";

function Probe() {
  const { filters, setFilters, resetFilters } = useFilterState();
  const location = useLocation();
  return (
    <div>
      <span data-testid="filters">{JSON.stringify(filters)}</span>
      <span data-testid="search">{location.search}</span>
      <button data-testid="set" type="button" onClick={() => setFilters({ status: "on_hold" })} />
      <button data-testid="reset" type="button" onClick={() => resetFilters()} />
    </div>
  );
}

describe("useFilterState (URL-backed)", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(initialUrl: string) {
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={[initialUrl]}>
          <Probe />
        </MemoryRouter>
      );
    });
  }
  const filters = () => JSON.parse(container.querySelector('[data-testid="filters"]')!.textContent || "{}");
  const search = () => container.querySelector('[data-testid="search"]')!.textContent || "";

  it("reads FilterBar params from the URL and ignores non-FilterBar params", () => {
    render("/deals?filter=won&period=ytd&search=acme&status=on_hold");
    expect(filters()).toEqual({ search: "acme", status: "on_hold" });
  });

  it("setFilters updates a param and preserves non-FilterBar params", () => {
    render("/deals?filter=won&search=acme");
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="set"]')?.click());
    expect(filters()).toEqual({ search: "acme", status: "on_hold" });
    expect(search()).toContain("filter=won");
    expect(search()).toContain("status=on_hold");
  });

  it("resetFilters clears FilterBar params but keeps non-FilterBar params", () => {
    render("/deals?filter=won&search=acme&status=on_hold");
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="reset"]')?.click());
    expect(filters()).toEqual({});
    expect(search()).toContain("filter=won");
    expect(search()).not.toContain("search=acme");
  });
});
