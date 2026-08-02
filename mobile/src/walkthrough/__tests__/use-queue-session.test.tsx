/**
 * Covers useWalkQueueSession — the one place the walk queue's identity and its 401 authority are
 * decided, for all three foreground drain sites (the authenticated shell, walk.tsx, Profile's
 * failed-walk retry).
 *
 * The defect this pins: a drain deliberately OUTLIVES the component that started it, because
 * abandoning a multi-gigabyte upload at sign-out is a worse failure than letting it finish. But the
 * fetcher it carries holds that session's token and that session's signOut. Once someone else signs
 * in, the old token is revoked, the abandoned drain's next call 401s, and an unguarded
 * onUnauthorized clears the auth state of the user who just signed IN.
 *
 * Testing the hook rather than each screen is deliberate: the screens' own tests already cover WHEN
 * they drain, and duplicating the 401 scoping into three renders would let two of them silently
 * drift from the third — which is exactly how this shipped in three places to begin with.
 */
let mockAuth: {
  token: string | null;
  user: { id: string; tenantId: string } | null;
  activeOfficeId: string | null;
  signOut: () => void;
};
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => mockAuth }));
jest.mock("../../api/client", () => ({ apiFetch: jest.fn(async () => ({})) }));

import { act, render } from "@testing-library/react-native";
// eslint-disable-next-line import/first
import { apiFetch } from "../../api/client";
// eslint-disable-next-line import/first
import type { Fetcher } from "../../api/endpoints";
// eslint-disable-next-line import/first
import { useWalkQueueSession } from "../use-queue-session";

const apiFetchMock = apiFetch as jest.Mock;

/** The last fetcher the hook produced, captured the way a drain captures one: handed over once and
 *  then held, so it keeps working against its own generation after the hook has moved on. */
let captured: { ownerKey: string | null; queueFetcher: Fetcher } | null = null;

function Probe() {
  captured = useWalkQueueSession();
  return null;
}

/**
 * Drive a captured fetcher the way a live drain does: issue a request, then fire the 401 callback
 * apiFetch would have fired. That callback — not the fetcher itself — is what can end a session.
 */
async function fire401(fetcher: Fetcher): Promise<void> {
  await fetcher("/deals/deal-1/glasses-walkthroughs", { method: "POST" });
  const opts = apiFetchMock.mock.calls.at(-1)![1] as { onUnauthorized?: () => void };
  opts.onUnauthorized?.();
}

describe("useWalkQueueSession", () => {
  let signOut: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    captured = null;
    signOut = jest.fn();
    mockAuth = {
      token: "token-1",
      user: { id: "user-1", tenantId: "office-primary" },
      activeOfficeId: "office-a",
      signOut,
    };
  });

  it("derives the same owner key the background drain task and owner-key.ts derive", () => {
    render(<Probe />);
    expect(captured!.ownerKey).toBe("user-1:office-a");
  });

  it("falls back to the primary office when no office is explicitly active", () => {
    mockAuth.activeOfficeId = null;
    render(<Probe />);
    expect(captured!.ownerKey).toBe("user-1:office-primary");
  });

  it("signs out on a 401 while its session is still the live one", async () => {
    // Positive control. The guard must not be so eager that a genuinely dead token stops ending
    // the session — that would strand a user in a signed-in shell whose every request fails.
    render(<Probe />);
    await act(async () => {
      await fire401(captured!.queueFetcher);
    });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("can no longer sign anyone out once its session has been superseded", async () => {
    // THE regression. Take the fetcher the way a drain does, unmount the shell that made it (what
    // sign-out does), then let the still-running drain 401 against its revoked token.
    const view = render(<Probe />);
    const abandoned = captured!.queueFetcher;
    view.unmount();

    await act(async () => {
      await fire401(abandoned);
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("keeps honouring 401s after a remount, rather than staying retired", async () => {
    // StrictMode and Fast Refresh both run cleanup-then-effect against the same session object. A
    // hook that only ever set `retired` would come back permanently deaf to real 401s.
    const view = render(<Probe />);
    view.rerender(<Probe />);

    await act(async () => {
      await fire401(captured!.queueFetcher);
    });
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
