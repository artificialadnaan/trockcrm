/**
 * app/(app)/reports/index.tsx — that the route to an ALREADY DELIVERED report is on the card at all.
 *
 * status.ts now answers "is there an earlier week the client may still ask about" as a pure function, and
 * its own suite pins every case. This file exists because that is not the part that broke. #1094 shipped the
 * right report id on the payload and the right gate in the module; what it got wrong was WHERE the card
 * asked — inside the `action.kind === "done"` branch, which is a fact about THIS week, not about last one.
 *
 * So the route existed only while the current week was still `sent`. A cadence rollover flipped the action
 * to `start` and the button vanished, taking with it the only path the phone had to a report the client
 * actually received. The feature's entire premise — "the client lost the email, send them another link" —
 * happens weeks later, which is exactly when the branch stopped matching.
 *
 * A unit test on the module could not have caught that, and did not: the module was already correct. This
 * renders the real screen with a real rolled-over cadence and looks for the button. `mobile/` is neither
 * compiled nor run by CI and has no OTA, so the gap between "the decision is right" and "the screen asks
 * it" is a wrong app on somebody's phone until the next store release.
 */
import React from "react";
import { act, render } from "@testing-library/react-native";
import type { WeeklyReportAssignment, WeeklyReportAssignmentsResponse } from "../api/types";
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
  getWeeklyReport: jest.fn(async () => ({})),
  getWeeklyReportAssignments: jest.fn(async () => mockAssignments),
}));

jest.mock("../weekly-reports/draft-store", () => ({
  listWeeklyReportDrafts: jest.fn(async () => []),
  saveWeeklyReportDraft: jest.fn(async () => undefined),
  deleteWeeklyReportDraft: jest.fn(async () => undefined),
}));

jest.mock("../capture/upload-queue", () => ({
  newClientUploadId: () => "draft-1",
  uploadOwnerKey: () => "owner-1",
}));
jest.mock("../scorecards/ids", () => ({ newSubmissionId: () => "sub-1" }));

const mockRouterPush = jest.fn();

// eslint-disable-next-line import/first
import ReportsHubScreen from "../../app/(app)/reports/index";

/**
 * A PM whose client got last week's report, and whose NEW week has only just opened.
 *
 * This is the ordinary state of a healthy project on any day that is not send day, and it is the state in
 * which the button used to be missing. `currentState: "not_started"` ⇒ the card's action is `start`, so the
 * `done` branch the button used to live in does not render.
 */
function assignment(over: Partial<WeeklyReportAssignment> = {}): WeeklyReportAssignment {
  return {
    weeklyReportProjectId: "wrp-a",
    dealId: "deal-a",
    projectName: "4123 Cedar Springs",
    projectNumber: null,
    clientName: null,
    isSuper: false,
    isPm: true,
    cadenceWeekday: 5,
    currentWeekOf: "2026-08-17",
    currentState: "not_started",
    currentReportId: null,
    currentReportStatus: null,
    lastSentReportId: "rep-sent-last-week",
    lastSentWeekOf: "2026-08-10",
    currentWeekFilable: true,
    daysLate: 0,
    outstandingWeeks: [],
    hasMoreOutstandingWeeks: false,
    previousWeekOf: null,
    previousCompletionPercent: null,
    previousWeatherDelayDays: null,
    ...over,
  } as unknown as WeeklyReportAssignment;
}

let mockAssignments: WeeklyReportAssignmentsResponse;

function setProjects(...projects: WeeklyReportAssignment[]) {
  mockAssignments = {
    asOf: "2026-08-17T12:00:00Z",
    projects,
    pendingReview: [],
  } as unknown as WeeklyReportAssignmentsResponse;
}

/** Buttons on the rendered hub whose title is the delivery route. */
function deliveryButtons(tree: ReturnType<typeof render>) {
  return tree.UNSAFE_getAllByType(Button).filter((node) => node.props.title === "Delivery & client link");
}

beforeEach(() => {
  jest.clearAllMocks();
  setProjects(assignment());
});

describe("the card offers a way back to the delivered report", () => {
  it("renders the delivery route even though THIS week is not started", () => {
    // THE REGRESSION. Nothing about this project is unusual — the client has last week's report, the new
    // week has opened and nobody has touched it yet. Before this fix the card rendered "Start week of…"
    // and nothing else, and the delivered report had no route on the phone at all.
    const tree = render(<ReportsHubScreen />);

    // Proof the card really is in the non-`done` shape, so this cannot pass for the wrong reason: if the
    // fixture ever drifted to a `sent` current week, the old code would ALSO render the button and this
    // test would go green while covering nothing.
    const starts = tree.UNSAFE_getAllByType(Button).filter((n) => {
      const t: unknown = n.props.title;
      return typeof t === "string" && t.startsWith("Start week of");
    });
    expect(starts).toHaveLength(1);

    expect(deliveryButtons(tree)).toHaveLength(1);
  });

  it("routes to the report that was SENT, not the week now open", async () => {
    const tree = render(<ReportsHubScreen />);
    await act(async () => {
      deliveryButtons(tree)[0]!.props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/(app)/reports/delivery/[reportId]",
        params: expect.objectContaining({ reportId: "rep-sent-last-week" }),
      }),
    );
  });

  it("still offers it when the current week is sent — the case that always worked", () => {
    // The fix moved the button OUT of the `done` branch. That must not have cost the one state it used to
    // work in; a fix that trades one broken case for another is not a fix.
    setProjects(assignment({ currentState: "sent", currentReportId: "rep-this-week" }));
    expect(deliveryButtons(render(<ReportsHubScreen />))).toHaveLength(1);
  });

  it("withholds it from an assigned superintendent, who would only reach a 403", () => {
    // Minting a client link needs `canPublishWeeklyReport`. A super sees this project on their own feed.
    setProjects(assignment({ isPm: false, isSuper: true }));
    expect(deliveryButtons(render(<ReportsHubScreen />))).toHaveLength(0);
  });

  it("withholds it when nothing has ever been delivered", () => {
    setProjects(assignment({ lastSentReportId: null, lastSentWeekOf: null }));
    expect(deliveryButtons(render(<ReportsHubScreen />))).toHaveLength(0);
  });
});
