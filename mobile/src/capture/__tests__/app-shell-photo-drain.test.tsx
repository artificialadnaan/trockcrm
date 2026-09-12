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
  const { View } = require("react-native");
  const Tabs = ({ children }: { children: React.ReactNode }) => ReactLib.createElement(View, null, children);
  Tabs.Screen = () => null;
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
}));
const mockGetQueuedCount = jest.fn(async (..._args: unknown[]): Promise<number> => 0);
const mockGetSchedulableCount = jest.fn(async (..._args: unknown[]): Promise<number> => 0);
jest.mock("../upload-queue", () => ({
  drainUploadQueue: (...args: unknown[]) => mockDrainUploadQueue(...args),
  getQueuedCount: (...args: unknown[]) => mockGetQueuedCount(...args),
  getSchedulableCount: (...args: unknown[]) => mockGetSchedulableCount(...args),
}));

let mockAuth: {
  ready: boolean;
  token: string | null;
  user: { id: string; tenantId: string } | null;
  activeOfficeId: string | null;
  signOut: jest.Mock;
};
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => mockAuth }));

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
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((type, handler) => {
    if (type === "change") appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderShell(): Promise<ReturnType<typeof render>> {
  const view = render(<AppLayout />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
});
