// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar, type FilterBarOptions, type FilterDimension } from "./filter-bar";
import type { FilterBarValue } from "./filterbar-params";

const OPTIONS: FilterBarOptions = {
  reps: [{ value: "rep-1", label: "Kevin Scott" }],
  stages: [
    { value: "opportunity", label: "Opportunity" },
    { value: "won", label: "Won" },
  ],
  sortOptions: [{ label: "Newest", sortBy: "created_at", sortDir: "desc" }],
};

describe("FilterBar", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(
    dimensions: FilterDimension[],
    extra: Partial<{ value: FilterBarValue; onChange: (p: Partial<FilterBarValue>) => void; onReset: () => void; stageEntryDateEnabled: boolean }> = {}
  ) {
    act(() => {
      root?.render(
        <FilterBar
          dimensions={dimensions}
          value={extra.value ?? {}}
          onChange={extra.onChange ?? (() => {})}
          onReset={extra.onReset ?? (() => {})}
          options={OPTIONS}
          stageEntryDateEnabled={extra.stageEntryDateEnabled}
        />
      );
    });
  }
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);

  it("renders only the configured dimensions", () => {
    render(["search", "status", "date", "stage"]);
    expect(q('input[aria-label="Search"]')).not.toBeNull();
    expect(q('button[aria-label="Status filter"]')).not.toBeNull();
    expect(q('button[aria-label="Date date filter"]')).not.toBeNull();
    expect(q('button[aria-label="Stage filter"]')).not.toBeNull();
    expect(q('button[aria-label="Rep filter"]')).toBeNull();
    expect(q('button[aria-label="Region filter"]')).toBeNull();
  });

  it("labels the date filter honestly as Won/Lost + activity when stage-entry dates are off", () => {
    render(["date"]);
    expect(q('[data-testid="date-scope-note"]')?.textContent).toContain("current state");
  });

  it("drops the honest note once stage-entry dates are enabled", () => {
    render(["date"], { stageEntryDateEnabled: true });
    expect(q('[data-testid="date-scope-note"]')).toBeNull();
  });

  it("emits an outcome-aware date window when a preset is chosen", () => {
    const onChange = vi.fn();
    render(["date"], { onChange });
    act(() => q('button[aria-label="Date date filter"]')?.click());
    const mtd = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "MTD");
    act(() => mtd?.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ datePreset: "mtd" }));
  });

  it("toggles a stage selection", () => {
    const onChange = vi.fn();
    render(["stage"], { onChange });
    act(() => q('button[aria-label="Stage filter"]')?.click());
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"][value="won"]');
    act(() => checkbox?.click());
    expect(onChange).toHaveBeenCalledWith({ stageIds: ["won"] });
  });

  it("calls onReset from the Clear button", () => {
    const onReset = vi.fn();
    render(["search"], { onReset });
    act(() => q('button[aria-label="Clear filters"]')?.click());
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
