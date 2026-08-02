/**
 * Covers the P2 fix on app/(app)/profile.tsx: RecoverableWalksCard must appear when the STARTUP SCAN
 * resolves, not when something unrelated happens to rerender the Profile screen.
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
import { __resetRecoverableStartupScanForTests, scanRecoverableWalksAtStartup } from "../upload";
// eslint-disable-next-line import/first
import ProfileScreen from "../../../app/(app)/profile";

const fs = FileSystem as unknown as { __store: Map<string, string> };
// Matches walkOwnerKey(user.id, activeOfficeId) for the mocked auth above.
const OWNER = "user-1:office-a";

beforeEach(() => {
  fs.__store.clear();
  __resetRecoverableStartupScanForTests();
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
