/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { AddressAutocomplete } from "./address-autocomplete";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// AddressAutocomplete is a CONTROLLED input: the parent owns `value`. So tests drive "typing" by
// re-rendering with a new `value` prop (what the parent does on each keystroke), not by dispatching
// raw input events at a controlled <input> (React's value-tracker would suppress those).
describe("AddressAutocomplete", () => {
  type SelectFn = (parts: { address: string; city: string; state: string; zip: string }) => void;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let onSelectSpy: ReturnType<typeof vi.fn<SelectFn>>;

  beforeEach(() => {
    apiMock.mockReset();
    onSelectSpy = vi.fn<SelectFn>();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(async () => {
    if (root) { const r = root; await act(async () => r.unmount()); }
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  function element(value: string) {
    return <AddressAutocomplete value={value} onChange={vi.fn()} onSelect={onSelectSpy} aria-label="Street" />;
  }
  function render(value: string) {
    act(() => { root = createRoot(container); root.render(element(value)); });
  }
  function rerender(value: string) {
    act(() => { root!.render(element(value)); }); // parent updated the controlled value (next keystroke)
  }
  async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  const suggestion = () => container.querySelector<HTMLButtonElement>('[data-testid="address-suggestion"]');

  it("does not query below MIN_QUERY_LENGTH (3)", async () => {
    vi.useFakeTimers();
    render("12");
    await tick(300);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("debounces and fires one request, renders suggestions", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ suggestions: [{ id: "1", label: "2711 N Haskell Ave, Dallas, TX 75204", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    render("2711 Haskell");
    await tick(250);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("/address/suggest?q="));
    expect(container.textContent).toContain("2711 N Haskell Ave, Dallas, TX 75204");
  });

  it("calls onSelect with parsed parts on suggestion click", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ suggestions: [{ id: "1", label: "L", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    render("2711 Haskell");
    await tick(250);
    await act(async () => suggestion()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelectSpy).toHaveBeenCalledWith({ address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" });
  });

  it("degrades on error and RETRIES on the next value change (no latch)", async () => {
    vi.useFakeTimers();
    apiMock.mockRejectedValueOnce(new Error("boom"));
    render("2711 Haskel");
    await tick(250);
    expect(suggestion()).toBeNull(); // this attempt degraded
    apiMock.mockResolvedValueOnce({ suggestions: [{ id: "1", label: "L", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    rerender("2711 Haskell"); // next keystroke (same component instance) — must retry, not latch
    await tick(250);
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(suggestion()).not.toBeNull();
  });
});
