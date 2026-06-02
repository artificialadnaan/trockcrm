// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresetSelect } from "./preset-select";

const OPTIONS = [
  { value: "dashboard", label: "Dashboard (YTD)" },
  { value: "7d", label: "7D" },
  { value: "wtd", label: "WTD" },
];

describe("PresetSelect", () => {
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

  it("shows the selected option's human label in the trigger, never the raw value (items-prop rule)", () => {
    act(() => {
      root?.render(<PresetSelect ariaLabel="Date range" value="dashboard" options={OPTIONS} onChange={() => {}} />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Date range"]');
    expect(trigger?.textContent).toContain("Dashboard (YTD)");
    expect(trigger?.textContent).not.toContain("dashboard");
  });

  it("renders every option with NO injected 'All' sentinel — the value is always set", () => {
    act(() => {
      root?.render(<PresetSelect ariaLabel="Date range" value="7d" options={OPTIONS} onChange={() => {}} />);
    });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Date range"]')?.click());
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Dashboard (YTD)", "7D", "WTD"]);
    expect(labels).not.toContain("All");
  });
});
