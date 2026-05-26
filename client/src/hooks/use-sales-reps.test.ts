/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSalesReps } from "./use-sales-reps";

const apiMock = vi.hoisted(() => vi.fn());

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
  apiMock.mockReset();
});

function mount(element: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
}

describe("useSalesReps", () => {
  it("does not fetch when enabled is false", async () => {
    apiMock.mockResolvedValue({ users: [] });
    function Probe() {
      useSalesReps(undefined, { enabled: false });
      return null;
    }
    mount(createElement(Probe));
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("fetches with no headers when officeId is undefined", async () => {
    apiMock.mockResolvedValue({ users: [{ id: "u1", displayName: "Rep One" }] });
    function Probe() {
      useSalesReps(undefined);
      return null;
    }
    mount(createElement(Probe));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [, init] = apiMock.mock.calls[0];
    expect(init?.headers).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("adds the reassignment purpose query only for deal reassignment pickers", async () => {
    apiMock.mockResolvedValue({ users: [{ id: "u1", displayName: "Rep One" }] });
    function Probe() {
      useSalesReps("office-a", { purpose: "deal-reassignment" });
      return null;
    }
    mount(createElement(Probe));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe("/users/sales-reps?purpose=deal-reassignment");
    expect(init?.headers).toEqual({ "x-office-id": "office-a" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the in-flight fetch when officeId changes so a stale response cannot win", async () => {
    const signals: AbortSignal[] = [];
    apiMock.mockImplementation((_path: string, init: any) => {
      signals.push(init.signal);
      return new Promise(() => {});
    });

    let setOffice: (next: string | undefined) => void = () => {};
    function Harness() {
      const [office, set] = useState<string | undefined>("office-a");
      setOffice = set;
      useSalesReps(office);
      return null;
    }
    mount(createElement(Harness));

    await vi.waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(1));

    act(() => {
      setOffice("office-b");
    });

    await vi.waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(2));

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
});
