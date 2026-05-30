// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchInput } from "./search-input";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// React tracks the input value via its own setter, so to simulate user typing we set
// the value through the native setter and dispatch a real "input" event (the no-
// @testing-library approach this repo uses).
function typeInto(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  debounceMs?: number;
  placeholder: string;
}

async function renderSearch(initial: {
  value?: string;
  onChange: (value: string) => void;
  debounceMs?: number;
  placeholder?: string;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props: Props = {
    value: initial.value ?? "",
    onChange: initial.onChange,
    debounceMs: initial.debounceMs,
    placeholder: initial.placeholder ?? "Search",
  };

  async function renderNow() {
    await act(async () => {
      root.render(createElement(SearchInput, { ...props }));
    });
  }
  await renderNow();

  return {
    get input() {
      return container.querySelector("input") as HTMLInputElement;
    },
    clearButton() {
      return container.querySelector('[aria-label="Clear search"]') as HTMLButtonElement | null;
    },
    async rerender(next: Partial<Props>) {
      Object.assign(props, next);
      await renderNow();
    },
    async type(value: string) {
      await act(async () => {
        typeInto(container.querySelector("input") as HTMLInputElement, value);
      });
    },
    async advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
    async clickClear() {
      await act(async () => {
        container
          .querySelector('[aria-label="Clear search"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

describe("SearchInput", () => {
  it("debounces onChange: no fire per keystroke, one fire after the delay with the latest value", async () => {
    const onChange = vi.fn();
    const ui = await renderSearch({ onChange, debounceMs: 300, placeholder: "Search deals" });

    await ui.type("a");
    await ui.type("ab");
    await ui.type("abc");
    expect(onChange).not.toHaveBeenCalled();

    await ui.advance(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("abc");
    ui.unmount();
  });

  it("renders typed text immediately (smooth, no remount/blank)", async () => {
    const onChange = vi.fn();
    const ui = await renderSearch({ onChange });

    await ui.type("abc");
    expect(ui.input.value).toBe("abc"); // visible instantly, before any debounce
    expect(onChange).not.toHaveBeenCalled();
    ui.unmount();
  });

  it("clears the field via the clear button and emits empty after the debounce", async () => {
    const onChange = vi.fn();
    const ui = await renderSearch({ onChange });

    await ui.type("abc");
    await ui.advance(300);
    expect(onChange).toHaveBeenLastCalledWith("abc");

    expect(ui.clearButton()).not.toBeNull();
    await ui.clickClear();
    expect(ui.input.value).toBe(""); // cleared instantly
    await ui.advance(300);
    expect(onChange).toHaveBeenLastCalledWith("");
    ui.unmount();
  });

  it("does not re-emit stale text when the value is cleared externally with a fresh inline callback", async () => {
    const onChange1 = vi.fn();
    const ui = await renderSearch({ value: "abc", onChange: onChange1 });
    expect(ui.input.value).toBe("abc");

    // Parent programmatically clears the value AND passes a new onChange identity (the
    // inline-callback URL/filter adoption pattern). This must NOT revert the clear by
    // re-emitting the previous text.
    const onChange2 = vi.fn();
    await ui.rerender({ value: "", onChange: onChange2 });
    await ui.advance(300);

    expect(onChange2).not.toHaveBeenCalled();
    expect(ui.input.value).toBe("");
    ui.unmount();
  });
});
