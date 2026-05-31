// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NumericRangePopover, summarizeRange } from "./numeric-range-popover";

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const DAY_BUCKETS = [
  { label: "> 30 days", min: 30 },
  { label: "> 60 days", min: 60 },
  { label: "> 90 days", min: 90 },
];

describe("summarizeRange", () => {
  it("shows the empty label when no bounds are set", () => {
    expect(summarizeRange({}, { emptyLabel: "Any" })).toBe("Any");
  });
  it("formats both bounds with the provided formatter", () => {
    expect(
      summarizeRange({ min: 10000, max: 50000 }, { format: (n) => `$${n.toLocaleString()}` })
    ).toBe("$10,000–$50,000");
  });
  it("shows a lower bound only", () => {
    expect(summarizeRange({ min: 30 }, { format: (n) => `${n}d` })).toBe("≥ 30d");
  });
  it("shows an upper bound only", () => {
    expect(summarizeRange({ max: 90 }, {})).toBe("≤ 90");
  });
  it("prefers a matching named bucket label", () => {
    expect(summarizeRange({ min: 90 }, { buckets: DAY_BUCKETS })).toBe("> 90 days");
  });
});

describe("NumericRangePopover", () => {
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

  it("shows the label and the empty summary in the trigger", () => {
    act(() => {
      root?.render(
        <NumericRangePopover label="Value" value={{}} onChange={() => {}} emptyLabel="Any" />
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Value filter"]');
    expect(trigger?.textContent).toContain("Value");
    expect(trigger?.textContent).toContain("Any");
  });

  it("emits a bucket range immediately when a bucket is clicked", () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <NumericRangePopover label="Stalled" value={{}} onChange={onChange} buckets={DAY_BUCKETS} />
      );
    });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Stalled filter"]')?.click());
    const bucketBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("> 60 days")
    );
    act(() => bucketBtn?.click());
    expect(onChange).toHaveBeenCalledWith({ min: 60, max: undefined });
  });

  it("commits the typed min/max bounds on Apply", () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(<NumericRangePopover label="Value" value={{}} onChange={onChange} />);
    });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Value filter"]')?.click());
    const minInput = document.querySelector<HTMLInputElement>('input[aria-label="Value minimum"]');
    expect(minInput).not.toBeNull();
    act(() => changeInputValue(minInput!, "25000"));
    const applyBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Apply");
    act(() => applyBtn?.click());
    expect(onChange).toHaveBeenCalledWith({ min: 25000, max: undefined });
  });
});
