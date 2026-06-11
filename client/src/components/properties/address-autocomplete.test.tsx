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

describe("AddressAutocomplete", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => { apiMock.mockReset(); container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(async () => { if (root) { const r = root; await act(async () => r.unmount()); } root = null; container.remove(); vi.useRealTimers(); });

  function render(props: Partial<Parameters<typeof AddressAutocomplete>[0]> = {}) {
    const onChange = props.onChange ?? vi.fn();
    const onSelect = props.onSelect ?? vi.fn();
    act(() => { root = createRoot(container); root.render(
      <AddressAutocomplete value={props.value ?? ""} onChange={onChange} onSelect={onSelect} aria-label="Street" />
    ); });
    return { onChange, onSelect };
  }
  const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Street"]')!;
  async function type(v: string) {
    await act(async () => { input().value = v; input().dispatchEvent(new Event("input", { bubbles: true })); });
  }
  async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

  it("does not query below MIN_QUERY_LENGTH (3)", async () => {
    vi.useFakeTimers();
    render({ value: "12" });
    await tick(300);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("debounces and fires one request, renders suggestions", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ suggestions: [{ id: "1", label: "2711 N Haskell Ave, Dallas, TX 75204", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    render({ value: "2711 Haskell" });
    await tick(250);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("/address/suggest?q="));
    expect(container.textContent).toContain("2711 N Haskell Ave, Dallas, TX 75204");
  });

  it("calls onSelect with parsed parts on suggestion click", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ suggestions: [{ id: "1", label: "L", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    const { onSelect } = render({ value: "2711 Haskell" });
    await tick(250);
    const option = container.querySelector<HTMLButtonElement>('[data-testid="address-suggestion"]')!;
    await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith({ address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" });
  });

  it("degrades on error and RETRIES on the next keystroke (no latch)", async () => {
    vi.useFakeTimers();
    apiMock.mockRejectedValueOnce(new Error("boom"));
    render({ value: "2711 Haskel" });
    await tick(250);
    expect(container.querySelector('[data-testid="address-suggestion"]')).toBeNull();
    apiMock.mockResolvedValueOnce({ suggestions: [{ id: "1", label: "L", address: "2711 N Haskell Ave", city: "Dallas", state: "TX", zip: "75204" }] });
    await type("2711 Haskell");
    await tick(250);
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="address-suggestion"]')).not.toBeNull();
  });
});
