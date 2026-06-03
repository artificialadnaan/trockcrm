/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateField } from "./date-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fireChange(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function fireBlur(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

function fireEnter(input: HTMLInputElement) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("DateField", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function getInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>("input[type='date']");
    if (!input) throw new Error("date input not found");
    return input;
  }

  it("fires onChange on every change (draft updates) but not onCommit", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    await act(async () => {
      root.render(<DateField value="" onChange={onChange} onCommit={onCommit} />);
    });

    await act(async () => {
      fireChange(getInput(), "2026-01-15");
    });

    expect(onChange).toHaveBeenCalledWith("2026-01-15");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("fires onCommit with the current value on blur", async () => {
    const onCommit = vi.fn();
    await act(async () => {
      root.render(
        <DateField value="2026-01-15" onChange={vi.fn()} onCommit={onCommit} />
      );
    });

    await act(async () => {
      fireBlur(getInput());
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2026-01-15");
  });

  it("fires onCommit with the current value on Enter", async () => {
    const onCommit = vi.fn();
    await act(async () => {
      root.render(
        <DateField value="2026-01-15" onChange={vi.fn()} onCommit={onCommit} />
      );
    });

    await act(async () => {
      fireEnter(getInput());
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2026-01-15");
  });

  it("is additive-safe: blur and Enter are no-ops when onCommit is absent", async () => {
    // Mirrors the other 4 consumers (lead-form, photo filters, deal-list) which
    // wire onChange to local state and never pass onCommit.
    const onChange = vi.fn();
    await act(async () => {
      root.render(<DateField value="" onChange={onChange} />);
    });
    const input = getInput();

    expect(() => {
      fireBlur(input);
      fireEnter(input);
    }).not.toThrow();

    // onChange behavior is unchanged for these consumers.
    await act(async () => {
      fireChange(input, "2026-02-01");
    });
    expect(onChange).toHaveBeenCalledWith("2026-02-01");
  });

  it("renders a non-conforming legacy value as blank (unchanged behavior)", async () => {
    await act(async () => {
      root.render(<DateField value="Q1 2026" onChange={vi.fn()} />);
    });
    expect(getInput().value).toBe("");
  });
});
