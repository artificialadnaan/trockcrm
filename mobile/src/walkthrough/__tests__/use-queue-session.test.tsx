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

  it("NEVER signs out on a 401, even while its own session is the live one", async () => {
    // This assertion is deliberately the reverse of what it once was, and the reversal came from
    // hardware. A 401 on a background upload is not evidence the session died — it is evidence one
    // request was not authorised, which on a real device turned out to mean "this endpoint rejects
    // this CLASS of session". The shell drains the queue the moment the authenticated tree mounts,
    // so signing out there produced: sign in -> drain -> 401 -> signed out -> sign in, forever. One
    // undeliverable walk made the app impossible to enter.
    //
    // A genuinely dead token still ends the session promptly — through whatever INTERACTIVE screen
    // the user touches next, which is a request they are actually waiting on.
    render(<Probe />);
    await act(async () => {
      await fire401(captured!.queueFetcher);
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("still never signs out after an unmount and remount", async () => {
    // The old implementation carried a `retired` flag that had to be re-armed on remount, and this
    // test guarded against it coming back permanently deaf. There is no flag any more — the fetcher
    // simply has no sign-out authority in any generation — so this now pins that the property holds
    // across a mount boundary rather than that a flag was reset correctly.
    const first = render(<Probe />);
    first.unmount();

    render(<Probe />);
    await act(async () => {
      await fire401(captured!.queueFetcher);
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a drain that outlives its shell cannot sign out the next user either", async () => {
    // The original regression, still worth pinning: an abandoned multi-gigabyte drain keeps running
    // with the token it was dispatched under. It could never end anyone's session now, but this
    // states the guarantee at the boundary that motivated the whole module.
    const view = render(<Probe />);
    const abandoned = captured!.queueFetcher;
    view.unmount();

    await act(async () => {
      await fire401(abandoned);
    });
    expect(signOut).not.toHaveBeenCalled();
  });
});
