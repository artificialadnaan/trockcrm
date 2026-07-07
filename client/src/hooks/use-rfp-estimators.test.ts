/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRfpEstimators, type RfpEstimatorOption } from "./use-rfp-estimators";

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

describe("useRfpEstimators", () => {
  it("does not fetch when enabled is false", async () => {
    apiMock.mockResolvedValue({ estimators: [] });
    function Probe() {
      useRfpEstimators(undefined, { enabled: false });
      return null;
    }
    mount(createElement(Probe));
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("fetches /deals/estimators with no headers when officeId is undefined", async () => {
    apiMock.mockResolvedValue({ estimators: [{ name: "Colby Burling", email: "cburling@trockgc.com" }] });
    function Probe() {
      useRfpEstimators(undefined);
      return null;
    }
    mount(createElement(Probe));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe("/deals/estimators");
    expect(init?.headers).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards the x-office-id header when an officeId is provided", async () => {
    apiMock.mockResolvedValue({ estimators: [{ name: "Colby Burling", email: "cburling@trockgc.com" }] });
    function Probe() {
      useRfpEstimators("office-a");
      return null;
    }
    mount(createElement(Probe));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe("/deals/estimators");
    expect(init?.headers).toEqual({ "x-office-id": "office-a" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends no header for the 'all' sentinel officeId", async () => {
    apiMock.mockResolvedValue({ estimators: [] });
    function Probe() {
      useRfpEstimators("all");
      return null;
    }
    mount(createElement(Probe));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    const [, init] = apiMock.mock.calls[0];
    expect(init?.headers).toBeUndefined();
  });

  it("coerces a non-array estimators payload to [] rather than throwing", async () => {
    apiMock.mockResolvedValue({ estimators: null as unknown as RfpEstimatorOption[] });
    const seen: RfpEstimatorOption[][] = [];
    function Probe() {
      const { estimators, loading } = useRfpEstimators(undefined);
      if (!loading) seen.push(estimators);
      return null;
    }
    mount(createElement(Probe));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(seen[seen.length - 1]).toEqual([]));
  });

  it("exposes error state and leaves estimators empty when the request rejects (non-abort)", async () => {
    apiMock.mockRejectedValue(new Error("estimators service is down"));
    const states: Array<{ loading: boolean; error: string | null; estimators: RfpEstimatorOption[] }> = [];
    function Probe() {
      const { estimators, loading, error } = useRfpEstimators(undefined);
      states.push({ loading, error, estimators });
      return null;
    }
    mount(createElement(Probe));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    await vi.waitFor(() => {
      const last = states[states.length - 1];
      expect(last.loading).toBe(false);
      expect(last.error).toBe("estimators service is down");
    });
    expect(states[states.length - 1].estimators).toEqual([]);
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
      useRfpEstimators(office);
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
