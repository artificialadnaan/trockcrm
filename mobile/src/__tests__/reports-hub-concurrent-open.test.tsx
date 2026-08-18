/**
 * app/(app)/reports/index.tsx — what stops a SECOND door opening while the first one is still reading.
 *
 * door.ts covers what one door does. This file covers how many of them there can be, which is a screen
 * question and therefore was not covered anywhere: `mobile/` is neither compiled nor run by CI and this
 * app has no OTA, so a guard that does not hold ships to phones and stays there for days.
 *
 * WHAT `disabled` DOES NOT COVER. Every week button on this hub carries
 * `disabled={busyKey !== null && busyKey !== ownKey}`, which means every one of them is ENABLED at rest.
 * Two Pressables in the same native event batch therefore both fire, and both read the render-time value
 * of `opening` — which is still null, because React has not re-rendered between them. That is one tap of
 * two fingers on two different weeks: two reads, two commits, two conflict dialogs stacked on each other
 * and answered in an order nobody chose. reports/weekly/[draftId].tsx already documents this exact hazard
 * on its photo import and solves it with a ref, and this is the same solution and the same reason.
 *
 * The two presses below are dispatched inside ONE `act`, without `fireEvent`, precisely so React cannot
 * re-render between them. Pressing through `fireEvent` twice would flush state after the first press and
 * quietly test a batch that never happens on a phone.
 */
import React from "react";
import { act, render } from "@testing-library/react-native";
import type {
  WeeklyReportAssignment,
  WeeklyReportAssignmentsResponse,
  WeeklyReportDetailResponse,
} from "../api/types";
import { Button } from "../components/ui";

jest.mock("expo-router", () => {
  const ReactLib = require("react");
  return {
    useFocusEffect: (callback: () => void | (() => void)) => {
      ReactLib.useEffect(() => callback(), [callback]);
    },
    useRouter: () => ({ push: mockRouterPush }),
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

// The assignments payload is fixed for these cases, so the real client would only add a resolution the
// test then has to wait for. Everything the screen reads off the query is supplied directly.
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockAssignments,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: jest.fn(async () => undefined),
  }),
}));

jest.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", tenantId: "tenant-1" },
    activeOfficeId: "office-1",
    fetcher: jest.fn(),
  }),
}));

jest.mock("../api/endpoints", () => ({
  getWeeklyReport: (fetcher: unknown, id: string) => mockGetWeeklyReport(fetcher, id),
  getWeeklyReportAssignments: jest.fn(async () => mockAssignments),
}));

jest.mock("../weekly-reports/draft-store", () => ({
  listWeeklyReportDrafts: jest.fn(async () => []),
  saveWeeklyReportDraft: (...args: unknown[]) => mockSaveDraft(...args),
  deleteWeeklyReportDraft: jest.fn(async () => undefined),
}));

// Ids have to be DISTINCT per call: two doors that mint the same draft id would collide on disk, which
// would hide the second write rather than prove it never happened.
let mockIdCounter = 0;
jest.mock("../capture/upload-queue", () => ({
  newClientUploadId: () => `draft-${++mockIdCounter}`,
  uploadOwnerKey: () => "owner-1",
}));
jest.mock("../scorecards/ids", () => ({
  newSubmissionId: () => `sub-${mockIdCounter}`,
}));

const mockRouterPush = jest.fn();
const mockSaveDraft = jest.fn(async (..._args: unknown[]) => undefined);
const mockGetWeeklyReport = jest.fn(async (_fetcher: unknown, id: string) => reportDetail(id));

// eslint-disable-next-line import/first
import ReportsHubScreen from "../../app/(app)/reports/index";

function assignment(suffix: string): WeeklyReportAssignment {
  return {
    weeklyReportProjectId: `wrp-${suffix}`,
    dealId: `deal-${suffix}`,
    projectName: suffix === "a" ? "4123 Cedar Springs" : "980 Preston Oaks",
    projectNumber: null,
    clientName: null,
    isSuper: true,
    isPm: false,
    cadenceWeekday: 5,
    currentWeekOf: "2026-08-13",
    // `draft` ⇒ the card offers "Open week of…" in AUTHOR mode, and `currentReportId` ⇒ that open goes
    // through the reconciling door rather than straight to disk. Both cards are in this state, so both
    // buttons are enabled and neither `disabled` rule has anything to say about the other.
    currentState: "draft",
    currentReportId: `rep-${suffix}`,
    currentReportStatus: "draft",
    currentWeekFilable: true,
    daysLate: 0,
    outstandingWeeks: [],
    hasMoreOutstandingWeeks: false,
    previousWeekOf: null,
    previousCompletionPercent: null,
    previousWeatherDelayDays: null,
  };
}

let mockAssignments: WeeklyReportAssignmentsResponse;

function reportDetail(id: string): WeeklyReportDetailResponse {
  const suffix = id.replace("rep-", "");
  return {
    report: {
      id,
      weeklyReportProjectId: `wrp-${suffix}`,
      dealId: `deal-${suffix}`,
      weekOf: "2026-08-13",
      version: 1,
      status: "draft",
      workCompleted: "Poured the north slab.",
      nextWeekLookAhead: null,
      issuesConcerns: null,
      completionPercent: null,
      weatherDelayDays: null,
      remainingWeeks: null,
      projectedDurationWeeks: null,
      authoredByName: null,
      photos: [],
    },
    permissions: { canEdit: true, canApprove: false },
  } as unknown as WeeklyReportDetailResponse;
}

/** The "Open week of…" buttons, in card order, taken from ONE render. */
function weekButtons(tree: ReturnType<typeof render>) {
  return tree.UNSAFE_getAllByType(Button).filter((node) => {
    const title: unknown = node.props.title;
    return typeof title === "string" && title.startsWith("Open week of");
  });
}

beforeEach(() => {
  mockIdCounter = 0;
  jest.clearAllMocks();
  mockAssignments = {
    asOf: "2026-08-17T12:00:00Z",
    projects: [assignment("a"), assignment("b")],
    pendingReview: [],
  } as unknown as WeeklyReportAssignmentsResponse;
});

describe("two week buttons pressed in one native event batch", () => {
  it("opens ONE door — the busy guard cannot be React state", async () => {
    const tree = render(<ReportsHubScreen />);
    const [first, second] = weekButtons(tree);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Both enabled at rest, which is the whole point: `disabled` closes the same-button case and says
    // nothing at all about two different weeks.
    expect(first!.props.disabled).toBeFalsy();
    expect(second!.props.disabled).toBeFalsy();

    await act(async () => {
      first!.props.onPress();
      second!.props.onPress();
    });

    // One read, and it is the first card's — not two reads racing, and not the second one winning.
    expect(mockGetWeeklyReport).toHaveBeenCalledTimes(1);
    expect(mockGetWeeklyReport.mock.calls[0]![1]).toBe("rep-a");
    // One commit and one navigation. Two doors here would have written two drafts and pushed the wizard
    // twice, landing the user on whichever route lost the race.
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
  });

  it("releases the guard, so the week that lost is one tap away", async () => {
    // The failure mode of the fix itself: a ref that is never cleared bars every door for the rest of the
    // session, and the screen has no other way in.
    const tree = render(<ReportsHubScreen />);
    const buttons = weekButtons(tree);
    await act(async () => {
      buttons[0]!.props.onPress();
      buttons[1]!.props.onPress();
    });
    expect(mockGetWeeklyReport).toHaveBeenCalledTimes(1);

    await act(async () => {
      weekButtons(tree)[1]!.props.onPress();
    });
    expect(mockGetWeeklyReport).toHaveBeenCalledTimes(2);
    expect(mockGetWeeklyReport.mock.calls[1]![1]).toBe("rep-b");
  });
});
