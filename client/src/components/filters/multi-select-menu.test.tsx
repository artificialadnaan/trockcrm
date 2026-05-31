// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultiSelectMenu, toggleSelection, summarizeSelection } from "./multi-select-menu";

const OPTIONS = [
  { value: "opportunity", label: "Opportunity" },
  { value: "estimating", label: "Estimating" },
  { value: "won", label: "Won" },
];

describe("toggleSelection", () => {
  it("adds an unselected value", () => {
    expect(toggleSelection(["a"], "b")).toEqual(["a", "b"]);
  });
  it("removes an already-selected value", () => {
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
  });
  it("adds to an empty selection", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
  });
});

describe("summarizeSelection", () => {
  it("shows the empty label when nothing is selected", () => {
    expect(summarizeSelection([], OPTIONS, "All")).toBe("All");
  });
  it("shows the option label when exactly one is selected", () => {
    expect(summarizeSelection(["estimating"], OPTIONS, "All")).toBe("Estimating");
  });
  it("shows a count when more than one is selected", () => {
    expect(summarizeSelection(["opportunity", "won"], OPTIONS, "All")).toBe("2 selected");
  });
});

describe("MultiSelectMenu", () => {
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

  it("renders the label and the empty summary in the trigger", () => {
    act(() => {
      root?.render(
        <MultiSelectMenu label="Stage" options={OPTIONS} value={[]} onChange={() => {}} emptyLabel="All" />
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Stage filter"]');
    expect(trigger?.textContent).toContain("Stage");
    expect(trigger?.textContent).toContain("All");
  });

  it("toggles a value on when its option is clicked in the open menu", () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <MultiSelectMenu label="Stage" options={OPTIONS} value={["won"]} onChange={onChange} emptyLabel="All" />
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Stage filter"]');
    act(() => trigger?.click());
    // PopoverContent portals to document.body.
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"][value="estimating"]');
    expect(checkbox).not.toBeNull();
    act(() => checkbox?.click());
    expect(onChange).toHaveBeenCalledWith(["won", "estimating"]);
  });
});
