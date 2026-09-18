/**
 * Covers the reported bug on app/(app)/_layout.tsx: entering (or returning to) the authenticated shell
 * must pick up photo captures that are ALREADY queued.
 *
 * The gap this closes. Photo captures drained from exactly two places — the Capture screen, and the
 * opportunistic iOS background window that upload-background-task.ts's own header calls a long-tail
 * safety net rather than a mechanism. Every other screen could not move the queue at all, including the
 * project gallery a superintendent is looking at when they ask where yesterday's photos went. Measured
 * on production: of 267 photos captured on Sep 10, zero reached the server that day.
 *
 * The sibling file ../../walkthrough/__tests__/app-shell-walk-drain.test.tsx is the same test for the
 * walk queue, which already had this resume. The upload module is mocked on purpose: this is a test
 * about WHEN the shell asks for a drain, not about what a drain does (upload-queue's own suites own
 * that).
 */
import { AppState, type AppStateStatus } from "react-native";

jest.mock("expo-router", () => {
  const ReactLib = require("react");
  const { View, Text } = require("react-native");
  const Tabs = ({ children }: { children: React.ReactNode }) => ReactLib.createElement(View, null, children);
  // Renders `tabBarBadge` rather than returning null. Without this the badge value never reaches the
  // tree, and every assertion about it passes whatever the code does — verified: with `Tabs.Screen = ()
  // => null`, the stale-read test below passed with its guard deleted. This also covers the wiring
  // itself, i.e. that the count is actually handed to tabBarBadge.
  Tabs.Screen = ({ options }: { options?: { tabBarBadge?: number } }) =>
    options?.tabBarBadge == null
      ? null
      : ReactLib.createElement(Text, { testID: "capture-tab-badge" }, String(options.tabBarBadge));
  return {
    Tabs,
    Redirect: () => null,
    usePathname: () => "/projects",
    useGlobalSearchParams: () => ({}),
  };
});

jest.mock("../../api/client", () => ({ apiFetch: jest.fn(async () => ({})) }));

// Walk side stubbed out: this file is about the photo queue's triggers.
jest.mock("../../walkthrough/upload-client", () => ({ walkthroughUploadClient: { id: "walk-upload-client" } }));
jest.mock("../../walkthrough/upload", () => ({
  scanRecoverableWalksAtStartup: jest.fn(async () => undefined),
  forgetRecoverableWalksAtStartup: jest.fn(),
  getSchedulableWalkCount: jest.fn(async () => 0),
  drainWalkQueue: jest.fn(async () => undefined),
}));

const mockRegisterUploadBackgroundTask = jest.fn(async () => undefined);
jest.mock("../upload-background-task", () => ({
  registerUploadBackgroundTask: () => mockRegisterUploadBackgroundTask(),
}));

const mockDrainUploadQueue = jest.fn(async (..._args: unknown[]) => ({
  succeeded: 0,
  failed: 0,
  remaining: 0,
  confirmedFileIds: {},
  shippedDealIds: [] as string[],
}));
const mockGetQueuedCount = jest.fn(async (..._args: unknown[]): Promise<number> => 0);
const mockGetSchedulableCount = jest.fn(async (..._args: unknown[]): Promise<number> => 0);
const mockQueueChangeListeners: Array<(ownerKey: string) => void> = [];
jest.mock("../upload-queue", () => ({
  drainUploadQueue: (...args: unknown[]) => mockDrainUploadQueue(...args),
  getQueuedCount: (...args: unknown[]) => mockGetQueuedCount(...args),
  getSchedulableCount: (...args: unknown[]) => mockGetSchedulableCount(...args),
  subscribeToQueueChanges: (listener: (ownerKey: string) => void) => {
    mockQueueChangeListeners.push(listener);
    return () => {
      const i = mockQueueChangeListeners.indexOf(listener);
      if (i >= 0) mockQueueChangeListeners.splice(i, 1);
    };
  },
}));

let mockAuth: {
  ready: boolean;
  token: string | null;
  user: { id: string; tenantId: string } | null;
  activeOfficeId: string | null;
  signOut: jest.Mock;
};
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => mockAuth }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react-native";
// eslint-disable-next-line import/first
import { apiFetch } from "../../api/client";
// eslint-disable-next-line import/first
import type { Fetcher } from "../../api/endpoints";
// eslint-disable-next-line import/first
import AppLayout from "../../../app/(app)/_layout";

/** uploadOwnerKey(user.id, activeOfficeId) for the auth below — the SAME namespace capture.tsx and the
 *  background task derive. A drain under any other string reads a queue nothing was written into. */
const OWNER = "user-1:office-a";

let appStateHandlers: Array<(status: AppStateStatus) => void>;
const apiFetchMock = apiFetch as jest.Mock;

beforeEach(() => {
  mockAuth = {
    ready: true,
    token: "token-1",
    user: { id: "user-1", tenantId: "tenant-1" },
    activeOfficeId: "office-a",
    signOut: jest.fn(),
  };
  apiFetchMock.mockClear();
  mockRegisterUploadBackgroundTask.mockClear();
  mockDrainUploadQueue.mockClear();
  mockGetQueuedCount.mockClear();
  mockGetQueuedCount.mockResolvedValue(0);
  mockGetSchedulableCount.mockClear();
  mockGetSchedulableCount.mockResolvedValue(0);
  mockQueueChangeListeners.length = 0;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((type, handler) => {
    if (type === "change") appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The shell reads a QueryClient (it invalidates project-photo queries after a drain), exactly as it
 *  does under the real root layout's QueryClientProvider. */
let queryClient: QueryClient;

let view: ReturnType<typeof render>;

async function renderShell(): Promise<ReturnType<typeof render>> {
  view = render(
    <QueryClientProvider client={queryClient}>
      <AppLayout />
    </QueryClientProvider>,
  );
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  return view;
}

describe("authenticated shell photo-queue drain", () => {
  it("drains the owner's already-queued photos on mount, from any screen in the shell", async () => {
    mockGetSchedulableCount.mockResolvedValue(12);

    await renderShell();

    expect(mockGetSchedulableCount).toHaveBeenCalledWith(OWNER);
    expect(mockDrainUploadQueue).toHaveBeenCalledTimes(1);
    expect((mockDrainUploadQueue.mock.calls[0] as unknown as [string])[0]).toBe(OWNER);
  });

  it("does not drain when nothing is schedulable — the common case stays a single index read", async () => {
    mockGetSchedulableCount.mockResolvedValue(0);

    await renderShell();

    expect(mockGetSchedulableCount).toHaveBeenCalledWith(OWNER);
    expect(mockDrainUploadQueue).not.toHaveBeenCalled();
  });

  it("drains again when the app returns to the foreground, having been empty at mount", async () => {
    mockGetSchedulableCount.mockResolvedValue(0);
    await renderShell();
    expect(mockDrainUploadQueue).not.toHaveBeenCalled();

    // The ordinary case: the crew shot photos, the phone locked, iOS suspended the app, and now they
    // open it again on the Projects tab. Before this effect existed, nothing here looked at the queue.
    mockGetSchedulableCount.mockResolvedValue(267);
    await act(async () => {
      for (const handler of appStateHandlers) handler("active");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockDrainUploadQueue).toHaveBeenCalledTimes(1);
  });

  it("ignores non-foreground AppState transitions", async () => {
    mockGetSchedulableCount.mockResolvedValue(5);
    await renderShell();
    mockDrainUploadQueue.mockClear();

    await act(async () => {
      for (const handler of appStateHandlers) handler("background");
      await Promise.resolve();
    });

    expect(mockDrainUploadQueue).not.toHaveBeenCalled();
  });

  it("never drains without a signed-in owner — an empty owner key would collapse into a shared namespace", async () => {
    mockAuth = { ...mockAuth, user: null };
    mockGetSchedulableCount.mockResolvedValue(9);

    await renderShell();

    expect(mockGetSchedulableCount).not.toHaveBeenCalled();
    expect(mockDrainUploadQueue).not.toHaveBeenCalled();
  });

  it("registers the background drain task, so a crew that never opens Capture still gets OS windows", async () => {
    await renderShell();
    expect(mockRegisterUploadBackgroundTask).toHaveBeenCalled();
  });

  /**
   * THE hazard of moving this drain into the shell, and the reason it needs its own fetcher.
   *
   * capture.tsx builds the photo queue's fetcher with `onUnauthorized: () => signOut()`. That is
   * survivable on a screen the user chose to open. The shell mounts for every authenticated route and
   * re-runs on every foreground, so the same fetcher here is the unbreakable loop the walk queue already
   * hit on real hardware: sign in -> shell drains -> one undeliverable photo 401s -> signed out -> sign
   * in, forever, with no way out from inside the app. One stuck capture would brick the app.
   */
  it("hands the drain a fetcher with NO sign-out authority — a 401 must not end the session", async () => {
    mockGetSchedulableCount.mockResolvedValue(1);
    await renderShell();

    const fetcher = (mockDrainUploadQueue.mock.calls[0] as unknown as [string, Fetcher])[1];
    expect(typeof fetcher).toBe("function");

    // Drive it the way a live drain does: make a request, then fire the 401 callback apiFetch would
    // have fired. That callback — not the fetcher itself — is the thing that can sign someone out.
    await fetcher("/field/photos/confirm-upload", { method: "POST" });
    const opts = apiFetchMock.mock.calls.at(-1)![1] as { onUnauthorized?: () => void; officeId?: string | null };
    expect(opts.onUnauthorized).toBeUndefined();
    opts.onUnauthorized?.();
    expect(mockAuth.signOut).not.toHaveBeenCalled();

    // And it must be scoped to the SAME office the owner key was built from, or the upload lands in
    // whichever office happens to be active instead of the one the photo was captured under.
    expect(opts.officeId).toBe("office-a");
  });

  /**
   * The motivating flow, end to end: the super is ON the project gallery when the shell's resume ships
   * his backlog. useProjectPhotos does not poll and React Query's window-focus refetch is a no-op in
   * React Native, so without an explicit invalidation the gallery keeps rendering the cached,
   * missing-photo list it had — the photos are on the server and the screen still says they are not.
   *
   * The deal ids come from the DRAIN SUMMARY, not from an inventory taken before it: a coalesced
   * follow-up pass can ship a photo for a deal that had nothing queued when the drain started.
   */
  it("invalidates the galleries the drain reports it shipped for", async () => {
    mockGetSchedulableCount.mockResolvedValue(2);
    mockDrainUploadQueue.mockResolvedValue({
      succeeded: 2,
      failed: 0,
      remaining: 0,
      confirmedFileIds: {},
      shippedDealIds: ["deal-boynton", "deal-other"],
    });

    await renderShell();
    const spy = jest.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      for (const handler of appStateHandlers) handler("active");
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const invalidated = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(invalidated).toContain(JSON.stringify(["projectPhotos", "user-1", "deal-boynton"]));
    expect(invalidated).toContain(JSON.stringify(["projectPhotos", "user-1", "deal-other"]));
  });

  it("invalidates nothing when the drain shipped nothing", async () => {
    mockGetSchedulableCount.mockResolvedValue(1);
    mockDrainUploadQueue.mockResolvedValue({
      succeeded: 0,
      failed: 1,
      remaining: 1,
      confirmedFileIds: {},
      shippedDealIds: [],
    });

    await renderShell();
    const spy = jest.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      for (const handler of appStateHandlers) handler("active");
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A badge that only refreshes on mount/foreground is wrong for the case that matters most: a crew
   * shooting photos with the app open. Those enqueues fire neither trigger, so the count sat stale — and
   * a badge reading 0 while 40 photos wait answers "did they send?" wrongly.
   */
  it("refreshes the pending count when the queue changes while the app stays open", async () => {
    mockGetSchedulableCount.mockResolvedValue(0);
    mockGetQueuedCount.mockResolvedValue(0);
    await renderShell();
    expect(mockQueueChangeListeners).toHaveLength(1);

    mockGetQueuedCount.mockClear();
    mockGetQueuedCount.mockResolvedValue(40);
    await act(async () => {
      for (const listener of mockQueueChangeListeners) listener(OWNER);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    // Re-read purely because the queue changed — no mount, no foreground transition, no drain.
    expect(mockGetQueuedCount).toHaveBeenCalledWith(OWNER);
    // ...and the new count actually reaches the badge.
    expect(view.getByTestId("capture-tab-badge").props.children).toBe("40");
  });

  it("shows no badge when the queue is empty", async () => {
    mockGetQueuedCount.mockResolvedValue(0);
    const rendered = await renderShell();
    expect(rendered.queryByTestId("capture-tab-badge")).toBeNull();
  });

  it("unsubscribes from queue changes on unmount", async () => {
    const view = await renderShell();
    expect(mockQueueChangeListeners).toHaveLength(1);
    view.unmount();
    expect(mockQueueChangeListeners).toHaveLength(0);
  });

  /**
   * Out-of-order badge reads. Every queue mutation notifies, so an enqueue followed immediately by a
   * successful drain starts two independent async counts with nothing ordering their resolution. If the
   * earlier read (queue non-empty) lands last, an unguarded update restores a positive count over the
   * newer zero — and the badge then sits there claiming photos are waiting when none are, until some
   * unrelated mutation corrects it.
   */
  it("ignores a stale badge read that resolves after a newer one", async () => {
    mockGetSchedulableCount.mockResolvedValue(0);
    await renderShell();
    expect(mockQueueChangeListeners).toHaveLength(1);

    // Two reads in flight: the FIRST sees 40 queued, the SECOND sees the queue emptied by a drain.
    // They are released in reverse, which is the race.
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    mockGetQueuedCount
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => { releaseFirst = () => resolve(40); }),
      )
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => { releaseSecond = () => resolve(0); }),
      );

    await act(async () => {
      for (const listener of mockQueueChangeListeners) listener(OWNER); // read #1 (40)
      for (const listener of mockQueueChangeListeners) listener(OWNER); // read #2 (0)
      await Promise.resolve();
      releaseSecond();                                                  // newer resolves FIRST
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      releaseFirst();                                                   // older resolves LAST
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    // The badge must reflect read #2 (the newest issued), not whichever happened to land last.
    expect(view.queryByTestId("capture-tab-badge")).toBeNull();
  });

  /**
   * Scope note, asserted so it cannot drift silently: the shell drains the ACTIVE namespace only.
   * Draining an old office's namespace needs a fetcher pinned to THAT office — an active-office fetcher
   * would confirm those captures into the wrong office — plus a cross-namespace badge and parked
   * requests for non-active owners. That is a separate change; the background task still covers those
   * namespaces in the meantime.
   */
  it("drains the active owner namespace only", async () => {
    mockGetSchedulableCount.mockResolvedValue(3);

    await renderShell();

    const drained = mockDrainUploadQueue.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(drained).toEqual([OWNER]);
  });
});
