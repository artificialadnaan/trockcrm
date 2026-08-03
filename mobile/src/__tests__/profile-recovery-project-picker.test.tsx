/**
 * Which projects the RECOVERY card is allowed to offer, in app/(app)/profile.tsx.
 *
 * The card's other behaviour — when it appears, what it says about a walk, that filing is
 * idempotent and retires the row — is covered in src/walkthrough/__tests__/profile-recoverable-card
 * .test.tsx. This file is only about the LIST the picker puts in front of the estimator, because
 * that list and the server's filing rule had drifted apart in the one direction that costs a site
 * visit. Scaffolding is deliberately the same shape as that file's (real upload module against an
 * in-memory filesystem, everything else on the screen stubbed so nothing else can rerender it).
 */
const DOC = "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/";

jest.mock("expo-file-system/legacy", () => {
  const store = new Map<string, string>();
  const mtimes = new Map<string, number>();
  return {
    __store: store,
    __mtimes: mtimes,
    documentDirectory: "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/",
    FileSystemUploadType: { BINARY_CONTENT: 0 },
    getInfoAsync: async (p: string) => ({
      exists: store.has(p),
      size: store.get(p)?.length,
      modificationTime: mtimes.get(p),
    }),
    readDirectoryAsync: async (dirUri: string) => {
      const prefix = dirUri.endsWith("/") ? dirUri : `${dirUri}/`;
      const names = new Set<string>();
      for (const p of store.keys()) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
    readAsStringAsync: async (
      p: string,
      options?: { encoding?: string; position?: number; length?: number },
    ) => {
      if (!store.has(p)) throw new Error(`ENOENT ${p}`);
      const raw = store.get(p)!;
      if (options?.encoding !== "base64") return raw;
      const from = options.position ?? 0;
      const to = options.length === undefined ? undefined : from + options.length;
      return Buffer.from(raw.slice(from, to), "binary").toString("base64");
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

jest.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", tenantId: "tenant-1", firstName: "Sam", email: "sam@example.com", role: "rep" },
    activeOfficeId: "office-a",
    token: "token-1",
    signOut: jest.fn(),
  }),
}));

jest.mock("../api/client", () => ({ apiFetch: jest.fn() }));
jest.mock("../wearables/native", () => ({ Wearables: {}, isAvailable: false }));
jest.mock("../settings/camera-roll-setting", () => ({
  getSaveToCameraRoll: jest.fn(async () => true),
  setSaveToCameraRoll: jest.fn(async () => undefined),
}));
jest.mock("../walkthrough/upload-client", () => ({ walkthroughUploadClient: {} }));

// ── The two answers the capture-target search can give ────────────────────────────────────────────
//
// `dealsOnly=true` is the SCORECARD question, and the server answers it with browsable field
// projects only — active pipeline or Won-family, never Lost/terminal (files/service.ts). Asked
// WITHOUT it, the same endpoint applies nothing to deals but `is_active = true`, which is exactly
// the set the glasses-walkthrough routes accept (assertAccessibleFieldCaptureTarget). The mock is
// keyed on that argument so a test can tell which question the screen actually asked, and the two
// answers are deliberately DISJOINT apart from one shared deal — a picker that merely swapped one
// question for the other would lose the browsable half, and this is what proves it did not.
const BROWSABLE_DEAL: FieldCaptureTarget = {
  id: "deal-77",
  type: "deal",
  name: "121 Preston Oaks",
  recordNumber: "DFW-1-17426-aa",
  stageName: "Construction",
  companyName: "Preston Oaks HOA",
  lastUpdatedAt: "2026-06-20T12:00:00.000Z",
};
const SHARED_DEAL: FieldCaptureTarget = {
  id: "deal-88",
  type: "deal",
  name: "Preston Ridge Center",
  recordNumber: "DFW-1-17999-aa",
  stageName: "Estimating",
  companyName: "Ridge Holdings",
  lastUpdatedAt: "2026-06-21T12:00:00.000Z",
};
/** The walk's own job, moved to Lost while the recording sat unfiled on the phone. */
const LOST_DEAL: FieldCaptureTarget = {
  id: "deal-99",
  type: "deal",
  name: "Preston Trails Apartments",
  recordNumber: "DFW-1-17500-aa",
  stageName: "Bid Lost",
  companyName: "Trails Management",
  lastUpdatedAt: "2026-06-22T12:00:00.000Z",
};
/** Comes back with the unfiltered question and must never be offered: both walkthrough endpoints are
 *  addressed by dealId, so a lead is not a destination this walk can be filed to at all. */
const A_LEAD: FieldCaptureTarget = {
  id: "lead-12",
  type: "lead",
  name: "Preston Hollow reroof enquiry",
  recordNumber: null,
  stageName: "New",
  companyName: null,
  lastUpdatedAt: "2026-06-23T12:00:00.000Z",
};

const mockUseCaptureTargets = jest.fn((_search: string, dealsOnly = false) => ({
  data: { targets: dealsOnly ? [BROWSABLE_DEAL, SHARED_DEAL] : [A_LEAD, LOST_DEAL, SHARED_DEAL] },
  isFetching: false,
}));
const mockUseNearbyCaptureTargets = jest.fn(() => ({
  data: { targets: [] as FieldCaptureTarget[] },
  isFetching: false,
}));
jest.mock("../query/hooks", () => ({
  useCaptureTargets: (...args: unknown[]) => mockUseCaptureTargets(...(args as [string, boolean])),
  useNearbyCaptureTargets: (...args: unknown[]) => mockUseNearbyCaptureTargets(...(args as [])),
}));
jest.mock("../capture/metadata", () => ({
  getLiveGps: jest.fn(async () => ({ latitude: 32.911, longitude: -96.775 })),
}));

import * as FileSystem from "expo-file-system/legacy";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { FieldCaptureTarget } from "../api/types";
import {
  forgetRecoverableWalksAtStartup,
  getQueuedWalks,
  scanRecoverableWalksAtStartup,
} from "../walkthrough/upload";
// eslint-disable-next-line import/first
import ProfileScreen from "../../app/(app)/profile";

const fs = FileSystem as unknown as { __store: Map<string, string>; __mtimes: Map<string, number> };
const OWNER = "user-1:office-a"; // walkOwnerKey(user.id, activeOfficeId) for the mocked auth above
const ORPHAN_DIR = `${DOC}walkthroughs/walk-orphan/`;

/** One top-level MP4 box: 32-bit size, 4-char type, zero-filled payload. */
function mp4Box(type: string, payloadBytes: number): string {
  const size = 8 + payloadBytes;
  const header = String.fromCharCode((size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff);
  return `${header}${type}${"\0".repeat(payloadBytes)}`;
}
const FINALIZED_MP4 = mp4Box("ftyp", 24) + mp4Box("mdat", 4096) + mp4Box("moov", 512);

beforeEach(() => {
  fs.__store.clear();
  fs.__mtimes.clear();
  forgetRecoverableWalksAtStartup();
  mockUseCaptureTargets.mockClear();
});

/** Profile with one orphaned walk already found by the shell's startup scan, picker open, and a
 *  search typed — the recovery flow at the moment the estimator has to name the job. */
async function openPickerAndSearch(term: string) {
  fs.__store.set(`${ORPHAN_DIR}walk.mp4`, FINALIZED_MP4);
  fs.__store.set(`${ORPHAN_DIR}owner`, "user-1_office-a"); // what claimWalkDirForOwner stamps
  fs.__mtimes.set(`${ORPHAN_DIR}walk.mp4`, 1_700_000_720); // epoch SECONDS
  const screen = render(<ProfileScreen />);
  await act(async () => {
    await scanRecoverableWalksAtStartup(OWNER);
  });
  fireEvent.press(screen.getByText("File to a project"));
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.changeText(screen.getByPlaceholderText("Search projects"), term);
  // The picker debounces typing by 200ms before it asks anything.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
  return screen;
}

// ── Round-11 FINDING B (P2): the picker refused the very deals the server accepts ─────────────────
//
// The walkthrough upload routes were deliberately widened (commit fde1d0a04) to take ANY active
// deal, terminal or not, because a walk drains for hours or days and a deal that moved to Lost in
// that window must not turn the remaining attempts into 404s. The recovery card, though, opened the
// SCORECARD picker (`dealsOnly`), whose server predicate is the field BROWSING rule — active
// pipeline or Won-family, never Lost. So for the one walk that most needs recovering — orphaned
// before it ever reached the manifest, on a bid that has since been lost — the app accepted the
// filing at the server and refused to let the estimator name the job.
describe("the project picker offered for an unfiled walk", () => {
  it("offers a deal that has moved to Lost, and files the walk against it", async () => {
    const screen = await openPickerAndSearch("preston");

    // The job the estimator actually walked. Its stage is shown so the choice is informed rather
    // than surprising — this is a widening, not a hiding.
    expect(screen.getByText(LOST_DEAL.name)).toBeTruthy();

    fireEvent.press(screen.getByText(LOST_DEAL.name));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const queued = await getQueuedWalks(OWNER);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.dealId).toBe(LOST_DEAL.id);
    expect(queued[0]!.title).toContain(LOST_DEAL.name);
  });

  // GUARD (passes before this change too): a lead comes back from the unfiltered search and must
  // still never be offered — both walkthrough endpoints are addressed by dealId, so filing a walk to
  // a lead could only ever 404, forever, on a recording that cannot be re-taken.
  it("still refuses to offer a lead", async () => {
    const screen = await openPickerAndSearch("preston");

    expect(screen.queryByText(A_LEAD.name)).toBeNull();
  });

  // GUARD (passes before this change too): the widening must be a SUPERSET, never a swap. The
  // browsable deals the ordinary picker lists are the common case, and a recovery flow that traded
  // them for terminal ones would fix the rare walk by breaking every other one — which is exactly
  // what asking ONLY the unfiltered question would risk, since without `dealsOnly` the server caps
  // leads and opportunities ahead of deals.
  it("still offers the ordinary, browsable projects alongside it", async () => {
    const screen = await openPickerAndSearch("preston");

    expect(screen.getByText(BROWSABLE_DEAL.name)).toBeTruthy();
  });

  // GUARD (trivially true before this change, since there was only one answer to list): a deal both
  // answers contain is ONE job, and the merge must not turn it into two rows that do the same thing.
  it("lists a deal that appears in both answers exactly once", async () => {
    const screen = await openPickerAndSearch("preston");

    expect(screen.getAllByText(SHARED_DEAL.name)).toHaveLength(1);
  });
});
