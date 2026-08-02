/**
 * Covers the two Profile cards that report on walks the estimator cannot otherwise see, and the one
 * defect both had: the card renders from a value the SCREEN cannot know has changed, so unless the
 * module publishes the change, real recordings stay invisible behind a card that never appears.
 *
 * Part one — RecoverableWalksCard must appear when the STARTUP SCAN resolves, not when something
 * unrelated happens to rerender the Profile screen.
 *
 * The bug this pins down is a cold launch that lands straight on Profile (the tab the app restores
 * to, or a deep link into it). The scan is kicked off by the authenticated shell's mount effect and
 * is async, so the card's first render reads `getRecoverableWalksFromStartup()` before it has an
 * answer. Completing the scan only assigned a module variable — no React state, no event — so the
 * card stayed hidden with real unqueued recordings sitting on the phone.
 *
 * The REAL upload module runs here (against an in-memory filesystem, like upload.test.ts): the whole
 * question is whether that module publishes scan completion, so mocking it would test the mock.
 * Everything else on the screen — pairing, auth, settings, navigation — is stubbed out; none of it
 * is what this bug is about, and each stub is chosen to settle BEFORE the scan so it can't
 * accidentally supply the rerender whose absence is the bug.
 */
const DOC = "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/";

jest.mock("expo-file-system/legacy", () => {
  const store = new Map<string, string>();
  // Last-modified times, in epoch SECONDS like the real expo-file-system reports them. The recovery
  // card's whole job is now to tell the estimator WHEN an orphan was recorded so they can place it,
  // so a mock that reported no timestamps could only ever exercise the "unknown" branch.
  const mtimes = new Map<string, number>();
  return {
    __store: store,
    __mtimes: mtimes,
    documentDirectory: "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/",
    FileSystemUploadType: { BINARY_CONTENT: 0 },
    getInfoAsync: async (p: string) => ({ exists: store.has(p), modificationTime: mtimes.get(p) }),
    readDirectoryAsync: async (dirUri: string) => {
      const prefix = dirUri.endsWith("/") ? dirUri : `${dirUri}/`;
      const names = new Set<string>();
      for (const p of store.keys()) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
    readAsStringAsync: async (p: string) => {
      if (!store.has(p)) throw new Error(`ENOENT ${p}`);
      return store.get(p)!;
    },
    writeAsStringAsync: async (p: string, data: string) => {
      store.set(p, data);
    },
    makeDirectoryAsync: async () => undefined,
    deleteAsync: async (p: string) => {
      store.delete(p);
    },
    moveAsync: async () => undefined,
    copyAsync: async () => undefined,
    uploadAsync: async () => ({ status: 200 }),
  };
});
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

jest.mock("expo-router", () => {
  const ReactLib = require("react");
  return {
    router: { push: jest.fn() },
    // Profile is a real, visible tab: its focus effect runs on mount and again on every genuine
    // refocus. A plain effect is a faithful stand-in for the one thing this test needs from it —
    // that it fires once, early, and resolves before the scan does.
    useFocusEffect: (callback: () => void | (() => void)) => {
      ReactLib.useEffect(() => callback(), [callback]);
    },
  };
});

jest.mock("react-native-safe-area-context", () => {
  const ReactLib = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) =>
      ReactLib.createElement(View, props, children),
  };
});

jest.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", tenantId: "tenant-1", firstName: "Sam", email: "sam@example.com", role: "rep" },
    activeOfficeId: "office-a",
    token: "token-1",
    signOut: jest.fn(),
  }),
}));

jest.mock("../../api/client", () => ({ apiFetch: jest.fn() }));

// No native bridge in this build: describePairing's first branch resolves SYNCHRONOUSLY, so the
// pairing row never schedules an async state update that could rerender the screen later.
jest.mock("../../wearables/native", () => ({
  Wearables: {},
  isAvailable: false,
}));

// Resolves to the same value the screen already initialises to, so its load is a React no-op
// (setState with an identical value bails out) rather than a stray rerender.
jest.mock("../../settings/camera-roll-setting", () => ({
  getSaveToCameraRoll: jest.fn(async () => true),
  setSaveToCameraRoll: jest.fn(async () => undefined),
}));

jest.mock("../upload-client", () => ({ walkthroughUploadClient: {} }));

// ── The project picker the recovery flow reuses ───────────────────────────────────────────────────
// The REAL TargetPicker renders here — it is the established project-choosing surface (capture.tsx,
// the scorecard editor), and swapping in a stub would test the stub rather than the wiring. Only its
// two data hooks and its GPS lookup are mocked, exactly as ../../components/__tests__/TargetPicker
// does: Profile is not otherwise a react-query screen, so there is no QueryClientProvider here.
// Typed through this seed value rather than inline: an inferred `never[]` would make every
// mockReturnValue carrying a real target a type error.
const NO_TARGETS: { data: { targets: FieldCaptureTarget[] }; isFetching: boolean } = {
  data: { targets: [] },
  isFetching: false,
};
const mockUseCaptureTargets = jest.fn(() => NO_TARGETS);
const mockUseNearbyCaptureTargets = jest.fn(() => NO_TARGETS);
jest.mock("../../query/hooks", () => ({
  useCaptureTargets: (...args: unknown[]) => mockUseCaptureTargets(...(args as [])),
  useNearbyCaptureTargets: (...args: unknown[]) => mockUseNearbyCaptureTargets(...(args as [])),
}));
jest.mock("../../capture/metadata", () => ({
  getLiveGps: jest.fn(async () => ({ latitude: 32.911, longitude: -96.775 })),
}));

import * as FileSystem from "expo-file-system/legacy";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { FieldCaptureTarget } from "../../api/types";
import {
  MAX_WALK_UPLOAD_ATTEMPTS,
  drainWalkQueue,
  forgetRecoverableWalksAtStartup,
  getQueuedWalks,
  scanRecoverableWalksAtStartup,
  type WalkthroughUploadClient,
} from "../upload";
// eslint-disable-next-line import/first
import ProfileScreen from "../../../app/(app)/profile";

const fs = FileSystem as unknown as { __store: Map<string, string>; __mtimes: Map<string, number> };
// Matches walkOwnerKey(user.id, activeOfficeId) for the mocked auth above.
const OWNER = "user-1:office-a";

beforeEach(() => {
  fs.__store.clear();
  fs.__mtimes.clear();
  // What the authenticated shell does on teardown — the previous test's session ending. The
  // snapshot is per shell lifecycle, and this suite is several of them in one process.
  forgetRecoverableWalksAtStartup();
});

describe("Profile's recoverable-walks card", () => {
  it("appears when the startup scan resolves, with nothing else rerendering the screen", async () => {
    // A walk directory native wrote but nothing ever queued — the app was killed before the enqueue
    // effect ran.
    fs.__store.set(`${DOC}walkthroughs/walk-orphan/walk.mp4`, "video-bytes");

    const { queryByText } = render(<ProfileScreen />);

    // Let every OTHER async effect on this screen settle FIRST. This is what makes the assertion
    // below meaningful: after this point nothing but the scan can cause a rerender, so a card that
    // shows up did so because the scan published, not because it caught a free ride on someone
    // else's setState.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryByText(/unfinished walk/)).toBeNull(); // scan hasn't run yet — nothing to claim

    // The shell's startup scan resolves (in the app this is (app)/_layout.tsx's mount effect).
    await act(async () => {
      await scanRecoverableWalksAtStartup(OWNER);
    });

    expect(queryByText(/unfinished walk/)).not.toBeNull();
    // The honest content, not just "a card rendered": one recording, no photos, and a way OUT of
    // the card. The action is deliberately "File to a project" rather than "Upload" — nothing on
    // disk says which deal this belongs to, so the estimator supplies it (see the filing suite
    // below); an Upload button would have to guess one.
    expect(queryByText(/1 recording/)).not.toBeNull();
    expect(queryByText("File to a project")).not.toBeNull();
  });

  it("stays hidden when the scan resolves with nothing to recover", async () => {
    const { queryByText } = render(<ProfileScreen />);
    await act(async () => {
      await scanRecoverableWalksAtStartup(OWNER);
    });
    expect(queryByText(/unfinished walk/)).toBeNull();
  });
});

// ── Round-7 FINDING (P1): the recovery card was a dead end ────────────────────────────────────────
//
// The card told the estimator the recording existed and to "mention this to support" — advice that
// is not merely unhelpful but false, because the files sit inside this app's own sandbox and support
// cannot reach them. `enqueueRecoveredWalk` was fully built and had no production caller, so the ONE
// surface that can save an unrepeatable site visit could not save one.
//
// It was left that way for a real reason, and that reason is what these tests pin down: an orphaned
// directory carries no dealId, both server endpoints require one, and a walk filed against the wrong
// job is worse than an unfiled walk — nobody catches it until a scope comes back describing the
// wrong building. So the fix is not a button that guesses. It is asking the person who was actually
// there, through the same project picker the rest of the app already uses.
describe("filing a recovered walk against a project the estimator picks", () => {
  const ORPHAN_DIR = `${DOC}walkthroughs/walk-orphan/`;
  const DEAL: FieldCaptureTarget = {
    id: "deal-77",
    type: "deal",
    name: "121 Preston Oaks",
    recordNumber: "DFW-1-17426-aa",
    stageName: "Construction",
    companyName: "Preston Oaks HOA",
    lastUpdatedAt: "2026-06-20T12:00:00.000Z",
    distanceMiles: 0.42,
  };

  beforeEach(() => {
    mockUseCaptureTargets.mockReturnValue(NO_TARGETS);
    // Served as "Closest jobs" the moment the picker opens, so these tests never depend on typing.
    mockUseNearbyCaptureTargets.mockReturnValue({ data: { targets: [DEAL] }, isFetching: false });
  });

  /** Render Profile with one orphaned walk already discovered by the shell's startup scan. */
  async function renderWithOrphan() {
    fs.__store.set(`${ORPHAN_DIR}walk.mp4`, "video-bytes");
    fs.__mtimes.set(`${ORPHAN_DIR}walk.mp4`, 1_700_000_720); // epoch SECONDS
    fs.__store.set(`${ORPHAN_DIR}still-001.jpg`, "a");
    fs.__mtimes.set(`${ORPHAN_DIR}still-001.jpg`, 1_700_000_000);
    const screen = render(<ProfileScreen />);
    await act(async () => {
      await scanRecoverableWalksAtStartup(OWNER);
    });
    return screen;
  }

  /** Open the picker and choose DEAL, then let the enqueue + its detached drain settle. */
  async function fileAgainstDeal(screen: ReturnType<typeof render>) {
    fireEvent.press(screen.getByText("File to a project"));
    await act(async () => {
      await Promise.resolve(); // the picker's GPS lookup, so "Closest jobs" is on screen
    });
    fireEvent.press(screen.getByText(DEAL.name));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("enqueues the orphan against the CHOSEN deal — the one fact only the estimator has", async () => {
    const screen = await renderWithOrphan();

    await fileAgainstDeal(screen);

    const queued = await getQueuedWalks(OWNER);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.walkId).toBe("walk-orphan");
    expect(queued[0]!.dealId).toBe("deal-77"); // never guessed — this is the picker's answer
    // Both artifacts came along: the video AND the still. A recovery that filed only what it could
    // most easily describe would silently drop evidence from a visit that cannot be re-taken.
    expect(queued[0]!.artifacts.map((a) => a.kind).sort()).toEqual(["photo", "video"]);
    // Titled from the walk's OWN recorded time, not the moment it was recovered, and marked as
    // recovered so the office knows the timeline was reconstructed rather than captured live.
    expect(queued[0]!.title).toContain("121 Preston Oaks");
    expect(queued[0]!.title).toContain("(recovered)");
  });

  it("retires the row once it is filed, so the same walk cannot be re-filed against a second project", async () => {
    const screen = await renderWithOrphan();

    await fileAgainstDeal(screen);

    // The card is gone: the walk now has a manifest entry and drains like any other. Leaving the
    // row up would invite a second filing under a DIFFERENT deal for a walk the queue already owns.
    expect(screen.queryByText(/unfinished walk/)).toBeNull();
    expect(screen.queryByText("File to a project")).toBeNull();
  });

  it("surfaces what is knowable about the walk, so the project choice is informed rather than blind", async () => {
    const screen = await renderWithOrphan();

    // When it was recorded (the last byte written), how much of it there is, and a lower-bound
    // duration from first write to last. These are the only clues to WHICH job this was.
    expect(screen.queryByText(/1 recording/)).not.toBeNull();
    expect(screen.queryByText(/1 photo/)).not.toBeNull();
    expect(screen.queryByText(/12 min/)).not.toBeNull();
    expect(screen.queryByText(/Nov 2023/)).not.toBeNull();
  });

  // GUARD, not a regression — it holds on either side of this change, because upsertQueuedWalk keys
  // on walkId. It is here because "recovery must be idempotent" is a property of the FLOW, not of
  // one function: the card kicks a drain and retires the row on the way through, and a second copy
  // of the walk would mean a second upload of a multi-GB video off a phone on cellular.
  it("cannot queue two copies when both halves of a double-tap reach the picker", async () => {
    const screen = await renderWithOrphan();
    fireEvent.press(screen.getByText("File to a project"));
    await act(async () => {
      await Promise.resolve();
    });

    // Both presses land before React processes the first one's state update, so both read the same
    // still-open picker.
    const row = screen.getByText(DEAL.name);
    fireEvent.press(row);
    fireEvent.press(row);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await getQueuedWalks(OWNER)).toHaveLength(1);
  });

  it("leaves the recording untouched and unqueued when the estimator backs out of the picker", async () => {
    const screen = await renderWithOrphan();

    fireEvent.press(screen.getByText("File to a project"));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.press(screen.getByText("Done")); // the picker's own dismiss
    await act(async () => {
      await Promise.resolve();
    });

    // Abandoning halfway costs nothing: no queue entry, the files are still on disk, and the card
    // is still offering the same way back in.
    expect(await getQueuedWalks(OWNER)).toEqual([]);
    expect(fs.__store.has(`${ORPHAN_DIR}walk.mp4`)).toBe(true);
    expect(screen.queryByText("File to a project")).not.toBeNull();
  });
});

// ── Round-6 FINDING 8 (P2): the failed-walk count is not a once-per-focus reading ─────────────────
//
// Part two, the same shape as the card above. `getFailedWalkCount` was read on focus and never
// again, so a drain that exhausts a walk's last retry WHILE Profile is already the focused tab
// publishes nothing — and Profile is exactly where the estimator sits waiting to find out. The card
// stayed hidden until they navigated away and back, which is not a step anyone knows to take about
// a card they cannot see. A drain is the ONLY thing that can make a walk terminal, and every step of
// one is a manifest mutation, so the manifest is the right thing to subscribe to.
describe("Profile's failed-walks card", () => {
  const MANIFEST_PATH = `${DOC}walkthrough-uploads/user-1_office-a/index.json`;
  // The artifact file is deliberately NOT seeded: putArtifactBytes rejects on a missing file before
  // it ever reaches the client, which is the cheapest honest way to make a drain fail. One attempt
  // short of the cap, so exactly one drain pass tips this walk over.
  const ONE_ATTEMPT_FROM_TERMINAL = [
    {
      walkId: "walk-1",
      dealId: "deal-1",
      projectId: null,
      title: "Riverside Plaza",
      siteLabel: "12 River Rd",
      startedAt: 1000,
      endedAt: 5000,
      durationMs: 4000,
      enqueuedAt: 1000,
      completionAttempts: 0,
      artifacts: [
        {
          idempotencyKey: "walk-1:video",
          kind: "video",
          uri: `${DOC}walkthroughs/walk-1/walk.mp4`,
          at: 1000,
          order: 0,
          attempts: MAX_WALK_UPLOAD_ATTEMPTS - 1,
        },
      ],
    },
  ];
  const client = {} as WalkthroughUploadClient; // never reached — the file is missing first
  const fetcher = jest.fn() as never;

  it("appears when a drain exhausts a walk's last retry while Profile is ALREADY focused", async () => {
    fs.__store.set(MANIFEST_PATH, JSON.stringify(ONE_ATTEMPT_FROM_TERMINAL));

    const { queryByText } = render(<ProfileScreen />);
    // Let the focus read — and every other async effect on this screen — settle first, so anything
    // that appears below did so because the queue published, not on someone else's setState.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryByText(/failed to upload/)).toBeNull(); // retries remain; nothing to report yet

    await act(async () => {
      await drainWalkQueue(OWNER, fetcher, client);
    });

    expect(queryByText(/1 walk failed to upload/)).not.toBeNull();
  });

  it("stays hidden while a walk still has retries left", async () => {
    fs.__store.set(
      MANIFEST_PATH,
      JSON.stringify([
        {
          ...ONE_ATTEMPT_FROM_TERMINAL[0],
          artifacts: [{ ...ONE_ATTEMPT_FROM_TERMINAL[0]!.artifacts[0]!, attempts: 0 }],
        },
      ]),
    );

    const { queryByText } = render(<ProfileScreen />);
    await act(async () => {
      await drainWalkQueue(OWNER, fetcher, client);
    });

    expect(queryByText(/failed to upload/)).toBeNull();
  });
});
