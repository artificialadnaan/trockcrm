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

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show Won deals from the last 60 days"]'
    );

    expect(button?.type).toBe("button");

    act(() => {
      button?.click();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onFilterChange).toHaveBeenCalledWith({ preset: "60" });
  });

  it("seeds a default custom range only when entering custom", () => {
    const onFilterChange = vi.fn();

    act(() => {
      root?.render(
        <TerminalDateFilterControl
          stageName="Won"
          filter={{ preset: "30" }}
          onFilterChange={onFilterChange}
        />
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Show Won deals from a custom date range"]')
        ?.click();
    });

    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange.mock.calls[0][0]).toMatchObject({ preset: "custom" });
    expect(onFilterChange.mock.calls[0][0].customStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("preserves an active custom range when custom is clicked again", () => {
    const onFilterChange = vi.fn();

    act(() => {
      root?.render(
        <TerminalDateFilterControl
          stageName="Won"
          filter={{ preset: "custom", customStart: "2026-04-01", customEnd: "2026-04-30" }}
          onFilterChange={onFilterChange}
        />
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Show Won deals from a custom date range"]')
        ?.click();
    });

    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it("does not refetch when clicking the currently active preset", () => {
    const onFilterChange = vi.fn();

    act(() => {
      root?.render(
        <TerminalDateFilterControl
          stageName="Won"
          filter={{ preset: "30" }}
          onFilterChange={onFilterChange}
        />
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Show Won deals from the last 30 days"]')
        ?.click();
    });

    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it("changes between non-active presets", () => {
    const onFilterChange = vi.fn();

    act(() => {
      root?.render(
        <TerminalDateFilterControl
          stageName="Won"
          filter={{ preset: "30" }}
          onFilterChange={onFilterChange}
        />
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Show Won deals from the last 60 days"]')
        ?.click();
    });

    expect(onFilterChange).toHaveBeenCalledWith({ preset: "60" });
  });
});
