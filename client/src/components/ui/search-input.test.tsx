import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { SearchInput } from "./search-input";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// The debounced onChange fires from a CHAINED effect (timer -> setDebounced -> render
// -> emit effect), so the timer must be advanced inside an ASYNC act to flush the full
// React 18 effect chain. (The behavior is correct in a real browser with real timers;
// only the test needs async flushing.)
describe("SearchInput", () => {
  it("debounces onChange: no fire per keystroke, one fire after the delay with the latest value", async () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} debounceMs={300} placeholder="Search deals" />);
    const input = screen.getByPlaceholderText("Search deals");

    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("renders typed text immediately (smooth, no remount/blank)", () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} placeholder="Search" />);
    const input = screen.getByPlaceholderText("Search") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.value).toBe("abc"); // visible instantly, before any debounce
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the field via the clear button and emits empty after the debounce", async () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} placeholder="Search" />);
    const input = screen.getByPlaceholderText("Search") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "abc" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onChange).toHaveBeenLastCalledWith("abc");

    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(input.value).toBe(""); // cleared instantly
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
