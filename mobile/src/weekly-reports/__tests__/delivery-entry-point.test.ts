import { weeklyReportDeliveryEntryPoint, weeklyReportProjectAction } from "../status";
import type { WeeklyReportWeekStateValue } from "../../api/types";

// THE ROUTE TO A DELIVERED REPORT, WHICH CLOSED ITSELF AFTER A WEEK.
//
// #1094 gave a field PM a way to re-mint the client link for their own report, and put the entry point to it
// inside the card's `action.kind === "done"` branch. `done` means the CURRENT week is `sent` or `dismissed`.
//
// So the button was reachable for as long as the current week stayed sent — and no longer. The moment the
// cadence rolled to a new week, `weeklyReportProjectAction` began returning `start` (or `resume`, or
// `review`), the `done` branch stopped rendering, and the only mobile route to the previously delivered
// report disappeared with it. `lastSentReportId` was still populated the whole time; nothing could read it.
//
// THAT IS THE FEATURE'S OWN USE CASE. "The client lost the email" does not happen during the send — it
// happens weeks later, by which point the current week is always something other than `done`. The one
// window in which the action was reachable is the one window in which nobody needs it: the brief period
// right after a send, when the client has just received the mail. Two reviewers found this independently.
//
// The decision now lives here rather than in the card's JSX, because `mobile/` has no OTA and its screens
// are not rendered by anything in CI. A rule expressed as a branch inside a component is a rule no test
// reaches; the same rule as a function is one these tests pin. The card asks this, unconditionally, and is
// no longer allowed an opinion about the current week's state.

interface HubProject {
  currentState: WeeklyReportWeekStateValue;
  isPm: boolean;
  currentWeekOf: string;
  lastSentReportId?: string | null;
  lastSentWeekOf?: string | null;
}

/** A hub project row, defaulted to the shape that hid the bug: delivered last week, new week just opened. */
function project(over: Partial<HubProject> = {}): HubProject {
  return {
    currentState: "not_started",
    isPm: true,
    currentWeekOf: "2026-08-17",
    lastSentReportId: "report-abc",
    lastSentWeekOf: "2026-08-10",
    ...over,
  };
}

describe("a delivered report keeps a way in", () => {
  it("offers the delivery screen once the cadence has moved past the sent week", () => {
    // THE REGRESSION, stated directly. The current week is `not_started`, so the card's action is `start`
    // and the old `done` branch renders nothing at all.
    const p = project();
    expect(weeklyReportProjectAction(p).kind).toBe("start");
    expect(weeklyReportDeliveryEntryPoint(p)).toEqual({
      reportId: "report-abc",
      weekOf: "2026-08-10",
    });
  });

  it.each([
    ["sent", "done"],
    ["not_started", "start"],
    ["draft", "resume"],
    ["pending_review", "review"],
    ["approved", "review"],
    ["dismissed", "done"],
  ])("survives a current week that is %s (action: %s)", (currentState, expectedKind) => {
    // Every state the current week can hold, because the defect was precisely that ONE of them kept the
    // route open and the rest closed it. Asserting the action kind alongside keeps this honest: if these
    // states ever stop producing the varied actions they produce today, the sweep would still pass while
    // covering far less than it reads as covering.
    const p = project({ currentState: currentState as WeeklyReportWeekStateValue });
    expect(weeklyReportProjectAction(p).kind).toBe(expectedKind);
    expect(weeklyReportDeliveryEntryPoint(p)?.reportId).toBe("report-abc");
  });

  it("points at the week that was SENT, not the week now open", () => {
    // The first attempt at #1094 used the current week's report id, which the server defines for
    // `currentWeekOf` alone — so a rolled-over cadence made the delivered report unreachable by a second,
    // independent route. The label on this button names a week; it must name the right one.
    expect(weeklyReportDeliveryEntryPoint(project())?.weekOf).toBe("2026-08-10");
  });

  it("withholds it from a superintendent, who would only reach a 403", () => {
    // Minting a client link needs `canPublishWeeklyReport`. An assigned superintendent appears on this feed
    // for their own projects and the week reads the same to them, so without this they get a button that
    // always fails — an app advertising something the person holding it cannot do.
    expect(weeklyReportDeliveryEntryPoint(project({ isPm: false }))).toBeNull();
  });

  it("withholds it when nothing has ever been delivered", () => {
    expect(weeklyReportDeliveryEntryPoint(project({ lastSentReportId: null }))).toBeNull();
  });

  it("withholds it on an older API build that does not send the field", () => {
    // The field arrived with #1094. A phone talking to an API that predates it receives no `lastSentReportId`
    // at all, and `undefined` must read as "no delivered report" rather than crashing the card.
    expect(weeklyReportDeliveryEntryPoint(project({ lastSentReportId: undefined }))).toBeNull();
  });

  it("still answers when the sent week is missing, rather than dropping the route", () => {
    // `lastSentWeekOf` is a LABEL; `lastSentReportId` is the route. If the server ever sends the id without
    // the week, losing the button would be the wrong trade — the caller can fall back for the wording.
    expect(weeklyReportDeliveryEntryPoint(project({ lastSentWeekOf: null }))).toEqual({
      reportId: "report-abc",
      weekOf: null,
    });
  });
});
