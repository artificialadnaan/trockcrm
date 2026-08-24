/**
 * @vitest-environment jsdom
 *
 * These hooks have to re-read when the TENANT SCOPE changes.
 *
 * `?officeId` is what `api()` turns into the `x-office-id` header, and that header is what picks the
 * schema. It is read from the URL at request time, not at render time — so a hook whose effect does not
 * depend on the office keeps showing the previous office's rows after a switch, while every action fired
 * from those rows is sent to the NEW tenant. Stale ids, new schema.
 *
 * Not hypothetical for this feature: the approver email links to
 * `/admin/marketing-expense-requests?officeId=…` and the confirmation to `/marketing-expense-requests?officeId=…`,
 * so arriving here with an office scope in the URL is the ordinary path, not an edge case.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMarketingExpenseQueue,
  useMyMarketingExpenseRequests,
} from "./use-marketing-expense-requests";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue({ requests: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/**
 * Renders a hook under a router and hands the test a real `navigate`.
 *
 * Re-rendering a fresh <MemoryRouter initialEntries> does NOT work: React reconciles it as the same
 * component and `initialEntries` is only read on first mount, so the URL never changes and the test passes
 * against a hook that ignores the office entirely. Driving `useNavigate` is an actual in-app office switch.
 */
let navigateTo: (url: string) => void = () => {};

function Harness({ useHook }: { useHook: () => unknown }) {
  const navigate = useNavigate();
  navigateTo = (url: string) => navigate(url);
  useHook();
  return null;
}

async function renderAt(url: string, useHook: () => unknown) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="*" element={<Harness useHook={useHook} />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** Lets a bespoke probe component sit under the same router while still exposing `navigate`. */
function ProbeWithNav({ Probe }: { Probe: () => null }) {
  const navigate = useNavigate();
  navigateTo = (url: string) => navigate(url);
  return <Probe />;
}

async function switchOfficeTo(url: string) {
  await act(async () => {
    navigateTo(url);
  });
}

describe("useMyMarketingExpenseRequests", () => {
  it("loads once on mount", async () => {
    await renderAt("/marketing-expense-requests", useMyMarketingExpenseRequests);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/marketing-expense-requests/mine");
  });

  it("RE-READS when only ?officeId changes", async () => {
    await renderAt("/marketing-expense-requests?officeId=office-a", useMyMarketingExpenseRequests);
    expect(api).toHaveBeenCalledTimes(1);

    await switchOfficeTo("/marketing-expense-requests?officeId=office-b");
    expect(api).toHaveBeenCalledTimes(2);
  });
});

describe("useMarketingExpenseQueue", () => {
  const queueAtPending = () => useMarketingExpenseQueue("pending");

  it("loads once on mount", async () => {
    await renderAt("/admin/marketing-expense-requests", queueAtPending);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/marketing-expense-requests?status=pending");
  });

  it("RE-READS when only ?officeId changes", async () => {
    await renderAt("/admin/marketing-expense-requests?officeId=office-a", queueAtPending);
    expect(api).toHaveBeenCalledTimes(1);

    await switchOfficeTo("/admin/marketing-expense-requests?officeId=office-b");
    expect(api).toHaveBeenCalledTimes(2);
  });
});

// A KEYED DEPENDENCY ANSWERS "HAVE I STARTED?", NOT "WHICH REQUEST IS THIS AN ANSWER TO?"
//
// Adding the office scope to the dependency list makes a switch RE-ISSUE the read. It does nothing about
// the first read still being in flight: if the old office's response lands second, it overwrites the new
// office's rows and the page shows another tenant's data with no indication anything is wrong. Every action
// fired from those rows then goes to the currently-scoped tenant.
//
// The fix is request identity captured at issue time and compared at resolution — losers are discarded
// without touching state.
describe("out-of-order responses", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("discards a stale response that resolves AFTER a newer one", async () => {
    const first = deferred<{ requests: unknown[] }>();
    const second = deferred<{ requests: unknown[] }>();
    api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const seen: unknown[][] = [];
    function Probe() {
      const { requests } = useMyMarketingExpenseRequests();
      seen.push(requests);
      return null;
    }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/marketing-expense-requests?officeId=office-a"]}>
          <Routes>
            <Route path="*" element={<ProbeWithNav Probe={Probe} />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await switchOfficeTo("/marketing-expense-requests?officeId=office-b");

    // Office B answers first, then the stale office-A read finally lands.
    await act(async () => {
      second.resolve({ requests: [{ id: "b-1" }] });
    });
    await act(async () => {
      first.resolve({ requests: [{ id: "a-1" }] });
    });

    const latest = seen[seen.length - 1] as Array<{ id: string }>;
    expect(latest.map((row) => row.id)).toEqual(["b-1"]);
  });

  it("a LOSER resolving first does not clear the loading latch the winner still owns", async () => {
    // The order that matters. If the stale office-A read resolves BEFORE office-B's, an unconditional
    // `setLoading(false)` in its finally block ends the spinner while the real read is still in flight —
    // the page renders its empty state and tells the user this office has no requests.
    const first = deferred<{ requests: unknown[] }>();
    const second = deferred<{ requests: unknown[] }>();
    api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const loadings: boolean[] = [];
    function Probe() {
      const { loading } = useMyMarketingExpenseRequests();
      loadings.push(loading);
      return null;
    }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/marketing-expense-requests?officeId=office-a"]}>
          <Routes>
            <Route path="*" element={<ProbeWithNav Probe={Probe} />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await switchOfficeTo("/marketing-expense-requests?officeId=office-b");

    // The STALE read answers first and must change nothing.
    await act(async () => {
      first.resolve({ requests: [{ id: "a-1" }] });
    });
    expect(loadings[loadings.length - 1]).toBe(true);

    // The winner then lands and ends the load.
    await act(async () => {
      second.resolve({ requests: [{ id: "b-1" }] });
    });
    expect(loadings[loadings.length - 1]).toBe(false);
  });
});
