/**
 * Covers the P1 fix on app/(app)/_layout.tsx: entering (or returning to) the authenticated shell
 * must pick up walks that are ALREADY queued.
 *
 * The gap this closes: the only foreground drain used to be walk.tsx's, fired once when a walk
 * reached a terminal state. Kill the process mid-drain and that trigger is gone forever — the
 * manifest still has the walk, but nothing in the foreground ever looks at it again. The background
 * task is explicitly opportunistic (upload-background-task.ts), so a perfectly schedulable multi-GB
 * recording could sit on the phone for hours while the estimator used the app normally. The shell's
 * mount effect is the right place because it is the one thing every authenticated path goes
 * through, and AppState 'active' covers the far more common case: the app was backgrounded
 * mid-upload and iOS suspended it.
 *
 * The upload module is mocked here on purpose — this is a test about WHEN the layout asks for a
 * drain, not about what a drain does (upload.test.ts owns that, against a real in-memory FS).
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
jest.mock("../upload-client", () => ({ walkthroughUploadClient: { id: "walk-upload-client" } }));

const mockScanRecoverableWalksAtStartup = jest.fn(async (..._args: unknown[]) => undefined);
const mockForgetRecoverableWalksAtStartup = jest.fn();
const mockGetSchedulableWalkCount = jest.fn(async (..._args: unknown[]): Promise<number> => 0);
const mockDrainWalkQueue = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../upload", () => ({
  scanRecoverableWalksAtStartup: (...args: unknown[]) => mockScanRecoverableWalksAtStartup(...args),
  forgetRecoverableWalksAtStartup: () => mockForgetRecoverableWalksAtStartup(),
  getSchedulableWalkCount: (...args: unknown[]) => mockGetSchedulableWalkCount(...args),
  drainWalkQueue: (...args: unknown[]) => mockDrainWalkQueue(...args),
}));

let mockAuth: {
  ready: boolean;
  token: string | null;
  user: { id: string; tenantId: string } | null;
  activeOfficeId: string | null;
  signOut: () => void;
};
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => mockAuth }));

import { act, render } from "@testing-library/react-native";
// eslint-disable-next-line import/first
import { apiFetch } from "../../api/client";
// eslint-disable-next-line import/first
import type { Fetcher } from "../../api/endpoints";
// eslint-disable-next-line import/first
import AppLayout from "../../../app/(app)/_layout";

/** walkOwnerKey(user.id, activeOfficeId) for the auth below — the SAME namespace walk.tsx, Profile
 *  and the background task derive, which is the whole point of that helper. */
const OWNER = "user-1:office-a";

/** AppState handlers registered during a render, so a test can drive a real foreground transition
 *  instead of hoping the emitter fires. */
let appStateHandlers: Array<(status: AppStateStatus) => void>;

const apiFetchMock = apiFetch as jest.Mock;

/** The fetcher a drain was handed, driven the way a live drain drives it: make a request, then fire
 *  the 401 callback apiFetch would have fired. That callback — not the fetcher itself — is the
 *  thing that can sign someone out. */
async function fire401(fetcher: Fetcher): Promise<void> {
  await fetcher("/deals/deal-1/glasses-walkthroughs", { method: "POST" });
  const opts = apiFetchMock.mock.calls.at(-1)![1] as { onUnauthorized?: () => void };
  opts.onUnauthorized?.();
}

beforeEach(() => {
  mockAuth = {
    ready: true,
    token: "token-1",
    user: { id: "user-1", tenantId: "tenant-1" },
    activeOfficeId: "office-a",
    signOut: jest.fn(),
  };
  mockScanRecoverableWalksAtStartup.mockClear();
  mockForgetRecoverableWalksAtStartup.mockClear();
  apiFetchMock.mockClear();
  mockGetSchedulableWalkCount.mockClear();
  mockGetSchedulableWalkCount.mockResolvedValue(0);
  mockDrainWalkQueue.mockClear();
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((type, handler) => {
    if (type === "change") appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Render and let the effects' async manifest reads settle. (`render` does its own act(); wrapping
 *  it in another one leaves the renderer unmounted.) */
async function renderShell(): Promise<ReturnType<typeof render>> {
  const view = render(<AppLayout />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

describe("authenticated shell walk-queue drain", () => {
  it("drains the owner's already-queued walks on mount — the resume path a killed process leaves behind", async () => {
    mockGetSchedulableWalkCount.mockResolvedValue(1);

    await renderShell();

    expect(mockGetSchedulableWalkCount).toHaveBeenCalledWith(OWNER);
    expect(mockDrainWalkQueue).toHaveBeenCalledTimes(1);
    const [ownerKey, , client] = mockDrainWalkQueue.mock.calls[0] as unknown as [string, unknown, unknown];
    expect(ownerKey).toBe(OWNER);
    expect(client).toEqual({ id: "walk-upload-client" });
  });

  it("does not drain when nothing is schedulable — the common case must stay a single manifest read", async () => {
    mockGetSchedulableWalkCount.mockResolvedValue(0);

    await renderShell();

    expect(mockGetSchedulableWalkCount).toHaveBeenCalledWith(OWNER);
    expect(mockDrainWalkQueue).not.toHaveBeenCalled();
  });

  it("drains again when the app returns to the foreground, having been empty at mount", async () => {
    mockGetSchedulableWalkCount.mockResolvedValue(0);
    await renderShell();
    expect(mockDrainWalkQueue).not.toHaveBeenCalled();

    // Backgrounded mid-walk, the walk got enqueued, iOS suspended the process, and now the
    // estimator opens the app again. Nothing else in the foreground would look at that queue.
    mockGetSchedulableWalkCount.mockResolvedValue(1);
    await act(async () => {
      for (const handler of appStateHandlers) handler("active");
      await Promise.resolve();
    });

    expect(mockDrainWalkQueue).toHaveBeenCalledTimes(1);
    expect((mockDrainWalkQueue.mock.calls[0] as unknown as [string])[0]).toBe(OWNER);
  });

  it("ignores non-foreground AppState transitions", async () => {
    mockGetSchedulableWalkCount.mockResolvedValue(1);
    await renderShell();
    mockDrainWalkQueue.mockClear();

    await act(async () => {
      for (const handler of appStateHandlers) handler("background");
      await Promise.resolve();
    });

    expect(mockDrainWalkQueue).not.toHaveBeenCalled();
  });

  it("never drains (or scans) without a signed-in owner — an empty owner key would collapse into a shared namespace", async () => {
    mockAuth = { ...mockAuth, user: null };
    mockGetSchedulableWalkCount.mockResolvedValue(1);

    await renderShell();

    expect(mockDrainWalkQueue).not.toHaveBeenCalled();
    expect(mockScanRecoverableWalksAtStartup).not.toHaveBeenCalled();
  });

  it("still runs the orphan-recovery scan it already owned", async () => {
    await renderShell();
    expect(mockScanRecoverableWalksAtStartup).toHaveBeenCalledWith(OWNER);
  });
});

// A drain is deliberately NOT cancelled when this shell goes away — abandoning a multi-GB upload on
// a navigation change is the failure the resume effect exists to prevent. What it does still hold is
// THIS session's token and THIS session's signOut, and neither survives sign-out with any meaning.
describe("a drain that outlives its shell", () => {
  it("can no longer sign anyone out — the next user's session is not this drain's to end", async () => {
    mockGetSchedulableWalkCount.mockResolvedValue(1);
    const view = await renderShell();
    const [, fetcher] = mockDrainWalkQueue.mock.calls[0] as unknown as [string, Fetcher];

    // Sign-out. The drain is still running — it finishes an R2 PUT, then its next API call is
    // rejected because the token it was started with has been revoked.
    view.unmount();
    await fire401(fetcher);

    // Before this fix that 401 ran the OLD shell's signOut, which clears in-memory auth state and
    // the persisted session — i.e. it signs out whoever is signed in NOW, not the user whose drain
    // this is.
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it("does NOT sign out when its own mount-time drain 401s — the lockout this caused was total", async () => {
    mockGetSchedulableWalkCount.mockResolvedValue(1);
    await renderShell();
    const [, fetcher] = mockDrainWalkQueue.mock.calls[0] as unknown as [string, Fetcher];

    // The reversal of an earlier assertion here, forced by real hardware. This shell drains the
    // queue on mount, so a walk the server will not accept produced an unbreakable cycle: sign in ->
    // mount -> drain -> 401 -> signed out -> sign-in screen. The user could not get into the app at
    // all, and nothing inside the app could clear the walk causing it.
    //
    // The 401 that started it was not a dead token; it was an endpoint that rejected this class of
    // session. A background upload is in no position to tell those apart, so it no longer tries —
    // the attempt is counted and surfaced on the failed-walk card instead. A genuinely dead token
    // still ends the session through the first interactive request the user makes.
    await fire401(fetcher);

    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it("forgets the startup scan when the shell tears down, so the next sign-in rescans", async () => {
    const view = await renderShell();
    expect(mockForgetRecoverableWalksAtStartup).not.toHaveBeenCalled();

    // The snapshot is only trustworthy as of shell entry, and it was taken against THIS owner's
    // manifest. Keeping it for the whole process means a same-process re-login (and the walk
    // useWalk finalized on the way out, specifically so it could be recovered) is never rescanned.
    view.unmount();

    expect(mockForgetRecoverableWalksAtStartup).toHaveBeenCalled();
  });
});
