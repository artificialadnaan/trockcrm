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
  return {
    __store: store,
    documentDirectory: "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/",
    FileSystemUploadType: { BINARY_CONTENT: 0 },
    getInfoAsync: async (p: string) => ({ exists: store.has(p) }),
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

import * as FileSystem from "expo-file-system/legacy";
import { act, render } from "@testing-library/react-native";
import {
  MAX_WALK_UPLOAD_ATTEMPTS,
  drainWalkQueue,
  forgetRecoverableWalksAtStartup,
  scanRecoverableWalksAtStartup,
  type WalkthroughUploadClient,
} from "../upload";
// eslint-disable-next-line import/first
import ProfileScreen from "../../../app/(app)/profile";

const fs = FileSystem as unknown as { __store: Map<string, string> };
// Matches walkOwnerKey(user.id, activeOfficeId) for the mocked auth above.
const OWNER = "user-1:office-a";

beforeEach(() => {
  fs.__store.clear();
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
    // The honest content, not just "a card rendered": one recording, no photos, and NO upload
    // action — nothing on disk says which deal an orphaned walk belongs to, and both server
    // endpoints require one (see findRecoverableWalks).
    expect(queryByText(/1 recording/)).not.toBeNull();
    expect(queryByText(/Upload/)).toBeNull();
  });

  it("stays hidden when the scan resolves with nothing to recover", async () => {
    const { queryByText } = render(<ProfileScreen />);
    await act(async () => {
      await scanRecoverableWalksAtStartup(OWNER);
    });
    expect(queryByText(/unfinished walk/)).toBeNull();
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
