// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilterSelect, resolveFilterSelectChange } from "./filter-select";

describe("resolveFilterSelectChange", () => {
  it("maps a real value to itself", () => {
    expect(resolveFilterSelectChange("rep-2")).toBe("rep-2");
  });
  it("maps the all sentinel / null / empty to undefined (omit the param)", () => {
    expect(resolveFilterSelectChange("__all__")).toBeUndefined();
    expect(resolveFilterSelectChange(null)).toBeUndefined();
    expect(resolveFilterSelectChange("")).toBeUndefined();
  });
  it("preserves the data-level __unassigned__ sentinel (it is a real choice)", () => {
    expect(resolveFilterSelectChange("__unassigned__")).toBe("__unassigned__");
  });
});

const REPS = [
  { value: "rep-1", label: "Kevin Scott" },
  { value: "rep-2", label: "Dana Lee" },
];

describe("FilterSelect", () => {
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

  it("shows the human label in the trigger, not the raw value (items-prop rule)", () => {
    act(() => {
      root?.render(<FilterSelect label="Rep" value="rep-1" options={REPS} onChange={() => {}} allLabel="All reps" />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Rep filter"]');
    expect(trigger?.textContent).toContain("Rep");
    expect(trigger?.textContent).toContain("Kevin Scott");
    expect(trigger?.textContent).not.toContain("rep-1");
  });

  it("shows the all-label when value is undefined", () => {
    act(() => {
      root?.render(<FilterSelect label="Rep" value={undefined} options={REPS} onChange={() => {}} allLabel="All reps" />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Rep filter"]');
    expect(trigger?.textContent).toContain("All reps");
  });
});
