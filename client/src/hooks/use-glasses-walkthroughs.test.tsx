// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDealGlassesWalkthroughs, type GlassesWalkthrough } from "./use-glasses-walkthroughs";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function walk(id: string): GlassesWalkthrough {
  return {
    id,
    walkId: `walk-${id}`,
    scopeWalkthroughId: null,
    capturedAt: "2026-08-02T22:21:47.702Z",
    capturedByUserId: null,
    capturedByName: null,
    captureCensus: null,
    narrationShortfallMs: null,
    state: "processing",
    scope: null,
  };
}

type Snapshot = ReturnType<typeof useDealGlassesWalkthroughs>;

function HookProbe({ dealId, onSnapshot }: { dealId: string; onSnapshot: (snapshot: Snapshot) => void }) {
  onSnapshot(useDealGlassesWalkthroughs(dealId));
  return null;
}

/** Mount the hook and hand back the latest snapshot plus a way to change the deal it is reading, which is
 *  what a user does by navigating from one deal to another WITHOUT this component ever unmounting. */
async function mountProbe(dealId: string) {
  const snapshots: Snapshot[] = [];
  const container = document.createElement("div");
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<HookProbe dealId={dealId} onSnapshot={(s) => snapshots.push(s)} />);
  });
  return {
    latest: () => snapshots[snapshots.length - 1]!,
    async switchTo(nextDealId: string) {
      await act(async () => {
        root!.render(<HookProbe dealId={nextDealId} onSnapshot={(s) => snapshots.push(s)} />);
      });
    },
    async settle() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

const pending = new Map<string, ReturnType<typeof deferred<{ walkthroughs: GlassesWalkthrough[] }>>>();

beforeEach(() => {
  apiMock.mockReset();
  pending.clear();
  apiMock.mockImplementation((path: string) => {
    const request = deferred<{ walkthroughs: GlassesWalkthrough[] }>();
    pending.set(path, request);
    return request.promise;
  });
});

function requestFor(dealId: string) {
  const request = pending.get(`/deals/${dealId}/glasses-walkthroughs`);
  if (!request) throw new Error(`no request was made for ${dealId}`);
  return request;
}

describe("useDealGlassesWalkthroughs", () => {
  it("reads the deal's walks and reports the answer as loaded", async () => {
    const probe = await mountProbe("deal-1");
    expect(probe.latest().hasLoaded).toBe(false);

    requestFor("deal-1").resolve({ walkthroughs: [walk("w1")] });
    await probe.settle();

    expect(apiMock).toHaveBeenCalledWith("/deals/deal-1/glasses-walkthroughs");
    expect(probe.latest().walkthroughs.map((w) => w.id)).toEqual(["w1"]);
    expect(probe.latest().hasLoaded).toBe(true);
    expect(probe.latest().loading).toBe(false);
    expect(probe.latest().error).toBeNull();
  });

  it("still reports the read as loaded when it FAILS, so the panel can show its own error", async () => {
    // Left unloaded, a permanently failing endpoint would be indistinguishable from a request still in
    // flight, and the panel — which renders nothing until it has an answer — would stay silently absent.
    const probe = await mountProbe("deal-1");
    requestFor("deal-1").reject(new Error("Internal server error"));
    await probe.settle();

    expect(probe.latest().hasLoaded).toBe(true);
    expect(probe.latest().error).toBe("Internal server error");
    expect(probe.latest().loading).toBe(false);
  });

  it("stops claiming to be loaded the moment the deal changes, so one deal's walks cannot render on another", async () => {
    // The scoping workspace is NOT remounted when the user navigates between deals — only `dealId` changes.
    // A one-way `hasLoaded` boolean stays true across that change, and the panel would render deal 1's walks,
    // dated and captioned, on deal 2's scoping tab with nothing on screen saying they were another project's.
    const probe = await mountProbe("deal-1");
    requestFor("deal-1").resolve({ walkthroughs: [walk("w1")] });
    await probe.settle();
    expect(probe.latest().hasLoaded).toBe(true);

    await probe.switchTo("deal-2");
    await probe.settle();

    expect(probe.latest().hasLoaded).toBe(false);

    requestFor("deal-2").resolve({ walkthroughs: [walk("w2")] });
    await probe.settle();
    expect(probe.latest().hasLoaded).toBe(true);
    expect(probe.latest().walkthroughs.map((w) => w.id)).toEqual(["w2"]);
  });

  it("REGRESSION: a failed load on the new deal, then a retry, does not resurrect the old deal's walks", async () => {
    // The path the deal-change guard did NOT cover. `hasLoaded` expires on the deal change, but the walks
    // array did not — nothing cleared it — and the failure stamp then marked deal 2 as loaded while the
    // array still held deal 1's. Clicking "Try again" clears the error, and `hasLoaded && !error && walks`
    // is exactly the panel's render condition: deal 1's site visit, dated and captioned, on deal 2's
    // scoping tab, under a heading reading "a glasses walkthrough of this project".
    const probe = await mountProbe("deal-1");
    requestFor("deal-1").resolve({ walkthroughs: [walk("w1")] });
    await probe.settle();
    expect(probe.latest().walkthroughs.map((w) => w.id)).toEqual(["w1"]);

    await probe.switchTo("deal-2");
    requestFor("deal-2").reject(new Error("Internal server error"));
    await probe.settle();

    // Loaded, and failed — the state the retry button renders from.
    expect(probe.latest().hasLoaded).toBe(true);
    expect(probe.latest().walkthroughs).toEqual([]);

    // Fired, not awaited: the retry's request is deliberately left in flight, because the bug window IS
    // the moment after the error clears and before the new answer lands.
    void probe.latest().refetch();
    await probe.settle();

    // Mid-retry: error cleared, deal 2 still unanswered. Nothing of deal 1's may be on screen.
    expect(probe.latest().error).toBe(null);
    expect(probe.latest().walkthroughs).toEqual([]);
  });

  it("does not let a slow answer for the previous deal overwrite the current deal's", async () => {
    // Ordinary rather than exotic: the server's read has a 5s ceiling, which is ample time to click away.
    // Without the request-generation guard the late response wins, and the panel shows deal 1's walks while
    // claiming to have loaded deal 2.
    const probe = await mountProbe("deal-1");
    await probe.switchTo("deal-2");

    requestFor("deal-2").resolve({ walkthroughs: [walk("w2")] });
    await probe.settle();
    requestFor("deal-1").resolve({ walkthroughs: [walk("w1")] });
    await probe.settle();

    expect(probe.latest().walkthroughs.map((w) => w.id)).toEqual(["w2"]);
    expect(probe.latest().hasLoaded).toBe(true);
  });

  it("does not let a slow FAILURE for the previous deal put an error on the current deal", async () => {
    const probe = await mountProbe("deal-1");
    await probe.switchTo("deal-2");

    requestFor("deal-2").resolve({ walkthroughs: [walk("w2")] });
    await probe.settle();
    requestFor("deal-1").reject(new Error("Internal server error"));
    await probe.settle();

    expect(probe.latest().error).toBeNull();
    expect(probe.latest().walkthroughs.map((w) => w.id)).toEqual(["w2"]);
  });

  it("keeps the current walks visible while a retry is in flight", async () => {
    // `loading` goes true again on every retry. A panel keyed on it rather than on `hasLoaded` would blank
    // out the walks the estimator is reading, mid-read.
    const probe = await mountProbe("deal-1");
    requestFor("deal-1").resolve({ walkthroughs: [walk("w1")] });
    await probe.settle();

    pending.clear();
    await act(async () => {
      void probe.latest().refetch();
    });

    expect(probe.latest().loading).toBe(true);
    expect(probe.latest().hasLoaded).toBe(true);
    expect(probe.latest().walkthroughs.map((w) => w.id)).toEqual(["w1"]);

    requestFor("deal-1").resolve({ walkthroughs: [] });
    await probe.settle();
    expect(probe.latest().walkthroughs).toEqual([]);
  });

  it("treats a response with no walkthroughs array as an empty list rather than crashing the panel", async () => {
    const probe = await mountProbe("deal-1");
    requestFor("deal-1").resolve({} as { walkthroughs: GlassesWalkthrough[] });
    await probe.settle();
    expect(probe.latest().walkthroughs).toEqual([]);
    expect(probe.latest().error).toBeNull();
  });
});
