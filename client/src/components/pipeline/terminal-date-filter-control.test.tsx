// @vitest-environment jsdom

import { act, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalDateFilterControl } from "./terminal-date-filter-control";

describe("TerminalDateFilterControl", () => {
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
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container.remove();
  });

  it("uses non-submitting buttons for preset changes", () => {
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const onFilterChange = vi.fn();

    act(() => {
      root?.render(
        <form onSubmit={onSubmit}>
          <TerminalDateFilterControl
            stageName="Won"
            filter={{ preset: "30" }}
            onFilterChange={onFilterChange}
          />
        </form>
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Won date filter"]');
    expect(trigger?.type).toBe("button");

    act(() => {
      trigger?.click();
    });

    const button = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Show Won deals from the last 90 days"]'
    );
    expect(button?.type).toBe("button");

    act(() => {
      button?.click();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onFilterChange).toHaveBeenCalledWith({ preset: "90" });
  });

  // Future dates should never be selectable for custom terminal ranges.
  it("caps custom date inputs at today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T14:00:00Z"));

    const onFilterChange = vi.fn();
    act(() => {
      root?.render(
        <TerminalDateFilterControl
          stageName="Lost"
          filter={{ preset: "custom", customStart: "2026-05-01" }}
          onFilterChange={onFilterChange}
        />
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Lost date filter"]')?.click();
    });

    const inputs = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.max === "2026-05-12")).toBe(true);

    vi.useRealTimers();
  });

});
