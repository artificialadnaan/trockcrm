// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The History tab is where a PM lands when they go looking for a report that did not arrive, so the
// controls it offers decide what they do next. Offering "Send correction" as the only action on a failed
// send is how a client ended up receiving nothing at all: the clone becomes the week's live version, the
// failure comes off the board with it, and a PM pulled away mid-draft leaves the board reading "approved,
// waiting on the PM" — indistinguishable from a Send button nobody has pressed.

const mocks = vi.hoisted(() => ({
  reports: [] as any[],
  refetch: vi.fn(),
  fetchWeeklyReportDetail: vi.fn(),
  createWeeklyReportCorrection: vi.fn(),
  retryWeeklyReportSend: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  useWeeklyReportHistory: () => ({
    reports: mocks.reports,
    loading: false,
    error: null,
    refetch: mocks.refetch,
  }),
  fetchWeeklyReportDetail: mocks.fetchWeeklyReportDetail,
  createWeeklyReportCorrection: mocks.createWeeklyReportCorrection,
  retryWeeklyReportSend: mocks.retryWeeklyReportSend,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { WeeklyReportHistoryPanel } from "./weekly-report-history-panel";

/**
 * The two shapes the worker persists into `send_error`.
 *
 * The prefix decides what the duplicate-risk dialog SAYS, never whether it appears — the gate is `sentAt`
 * and nothing else. `rejected:` means that attempt created nothing, so the dialog can say so; `unknown:`
 * means we never learned. A fixture without a prefix exercises neither branch honestly.
 */
const REJECTED_ERROR =
  "rejected: the email provider refused the message and sent nothing — " +
  "validation_error (422): Invalid `to` field";
const UNKNOWN_ERROR =
  "unknown: the email provider never confirmed the message, so it may or may not have gone out — " +
  "application_error: fetch failed";

const PROJECT = {
  id: "p1",
  propertyDisplayName: "4123 Cedar Springs",
  dealName: "4123 Cedar Springs",
  clientName: "Mack Real Estate Group",
} as any;

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    weekOf: "2026-08-13",
    version: 1,
    status: "sent",
    authoredByName: "Steve Sanchez",
    completionPercent: 42,
    photos: [],
    supersededById: null,
    sentAt: new Date().toISOString(),
    sendDeliveredAt: null,
    sendDeliveryStatus: null,
    sendDeliveryStatusAt: null,
    sendDeliveryDetail: null,
    sendError: null,
    sendAttempts: 0,
    // The SERVER's answer to "what may this reader do with this row". The default here is a rep's — the
    // broadest audience this tab has — so a row that acquires an edit or delete control has to say so
    // explicitly, rather than inheriting one from the fixture.
    permissions: {
      canEdit: false,
      canSubmit: false,
      canApprove: false,
      canReturnToDraft: false,
      canDelete: false,
    },
    ...overrides,
  };
}

/** A report the provider ACCEPTED and then reported as undeliverable — the state this feature exists for. */
function bounced(overrides: Record<string, unknown> = {}) {
  return report({
    sendDeliveredAt: "2026-08-13T22:00:00.000Z",
    sendDeliveryStatus: "bounced",
    sendDeliveryStatusAt: "2026-08-13T22:04:00.000Z",
    sendDeliveryDetail: { bounceClass: "hard", message: "550 5.1.1 user unknown" },
    ...overrides,
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.reports = [];
  mocks.refetch.mockReset();
  mocks.createWeeklyReportCorrection.mockReset();
  mocks.retryWeeklyReportSend.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render() {
  act(() => {
    root.render(
      <WeeklyReportHistoryPanel
        projects={[PROJECT]}
        refreshSignal={0}
        onSend={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

describe("a sent report the client has not received", () => {
  it("offers Retry send, not only a correction", () => {
    mocks.reports = [report({ sendError: REJECTED_ERROR })];
    render();
    expect(button("Retry send")).toBeDefined();
  });

  it("retries that exact report, inside the provider's dedupe window", async () => {
    mocks.retryWeeklyReportSend.mockResolvedValue({});
    mocks.reports = [report({ id: "v1", sendError: REJECTED_ERROR })];
    render();
    await act(async () => {
      button("Retry send")!.click();
    });
    expect(mocks.retryWeeklyReportSend).toHaveBeenCalledWith("v1", false);
  });

  // The three below cover the duplicate-risk confirmation, which had NO test at all: the shared `report()`
  // fixture stamps `sentAt: new Date().toISOString()`, so every other test in this file sits inside the
  // provider window and never reaches the dialog. Deleting the `window.confirm` from RetryButton outright
  // left both client suites green.
  //
  // What that hides is the worst outcome this feature has: past the window the provider no longer dedupes
  // the key, `retryWeeklyReportSend(reportId, true)` is exactly the flag that disables the server's 409
  // gate, and History is the surface a PM lands on when chasing a failed send. So a >24h retry would post
  // the acknowledgement with nobody having been asked, and the client gets a second copy of the report.
  //
  // Time is pinned with an absolute `now` AND an absolute `sentAt`. A fixture that is merely "long ago"
  // decays: the one relied on elsewhere sits ~424h in the past, which only ever caught a window above 424,
  // and that bound grows by 24 every real day.
  const NOW = new Date("2026-08-18T12:00:00.000Z");
  const SENT_25H_AGO = "2026-08-17T11:00:00.000Z";
  const SENT_23H_AGO = "2026-08-17T13:00:00.000Z";

  it("warns before retrying a send the provider will no longer dedupe, and obeys a refusal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      mocks.retryWeeklyReportSend.mockResolvedValue({});
      // `sendError: null` — the SILENT record: nothing was written either way, so the dialog can offer
      // no reassurance at all. The prompt's rejected-attempt sentence is asserted separately below; this
      // case must not acquire it.
      mocks.reports = [report({ id: "v1", sentAt: SENT_25H_AGO, sendError: null })];
      render();
      await act(async () => {
        button("Retry send")!.click();
      });
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/second copy/i));
      // And it must NOT reassure. Without this the prompt could claim "that attempt sent nothing" on
      // every outcome and this test would still pass — the exact overstatement being removed here.
      expect(confirm).not.toHaveBeenCalledWith(expect.stringMatching(/sent nothing/i));
      expect(mocks.retryWeeklyReportSend).not.toHaveBeenCalled();
      confirm.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges the duplicate risk explicitly once the PM accepts it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      mocks.retryWeeklyReportSend.mockResolvedValue({});
      mocks.reports = [report({ id: "v1", sentAt: SENT_25H_AGO, sendError: null })];
      render();
      await act(async () => {
        button("Retry send")!.click();
      });
      // `true` is what disables the server's 409 gate. It must only ever follow a dialog the PM saw, so
      // assert the dialog as well as the flag — checking the flag alone still passes if the confirm is
      // deleted, because the acknowledgement is needed either way.
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/second copy/i));
      expect(mocks.retryWeeklyReportSend).toHaveBeenCalledWith("v1", true);
      confirm.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing inside the window, where the key really does dedupe", async () => {
    // The CONTROL. Without it, a RetryButton that confirmed unconditionally — or one whose predicate
    // always returned false — would satisfy both tests above.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      mocks.retryWeeklyReportSend.mockResolvedValue({});
      // Silent here too, so this still tests the WINDOW. With an error recorded the retry is waved
      // through for a second, independent reason and the test would pass with the window check deleted.
      mocks.reports = [report({ id: "v1", sentAt: SENT_23H_AGO, sendError: null })];
      render();
      await act(async () => {
        button("Retry send")!.click();
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(mocks.retryWeeklyReportSend).toHaveBeenCalledWith("v1", false);
      confirm.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("STILL asks on a provable rejection, but SAYS that attempt sent nothing", async () => {
    // History is where a PM lands chasing a "Send failed" chip, and the original complaint was that this
    // dialog reads as "retrying is dangerous" — which sent them to Send correction instead, minting a v2
    // and taking the failure off the board.
    //
    // The fix is the sentence, not the gate. It still asks, because a recorded `rejected:` does not
    // prove the OTHER attempts failed to reach anyone — but it now credits what is known.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      mocks.retryWeeklyReportSend.mockResolvedValue({});
      mocks.reports = [report({ id: "v1", sentAt: SENT_25H_AGO, sendError: REJECTED_ERROR })];
      render();
      await act(async () => {
        button("Retry send")!.click();
      });
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/that attempt sent nothing/i));
      // BOTH halves asserted. A prompt that only reassured would satisfy the line above and would be
      // exactly the overstatement this round removed; the warning has to survive alongside it.
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/second copy/i));
      expect(mocks.retryWeeklyReportSend).toHaveBeenCalledWith("v1", true);
      confirm.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("STILL warns on an `unknown:` error, which is not evidence the send failed", async () => {
    // The distinction the prefix carries. `unknown:` is a swallowed fetch, a 5xx, a 408 or an in-flight
    // idempotency 409 — the request reached something that may have enqueued it, so the client may have
    // the report already. A row here has a long, specific, entirely real `send_error` and still cannot be
    // retried past the window without the PM agreeing.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      mocks.retryWeeklyReportSend.mockResolvedValue({});
      mocks.reports = [report({ id: "v1", sentAt: SENT_25H_AGO, sendError: UNKNOWN_ERROR })];
      render();
      await act(async () => {
        button("Retry send")!.click();
      });
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/second copy/i));
      // And it must NOT reassure. Without this the prompt could claim "that attempt sent nothing" on
      // every outcome and this test would still pass — the exact overstatement being removed here.
      expect(confirm).not.toHaveBeenCalledWith(expect.stringMatching(/sent nothing/i));
      expect(mocks.retryWeeklyReportSend).not.toHaveBeenCalled();
      confirm.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns before a correction that the send never reached the client", async () => {
    // The old confirm text described what a correction does to a client who HAS the report, which is the
    // wrong client entirely when the email failed. A PM reading it had no way to know this is not how a
    // failed send is fixed.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.reports = [report({ sendError: REJECTED_ERROR })];
    render();
    await act(async () => {
      button("Send correction")!.click();
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/never reached the client/i));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Retry send instead/i));
    expect(mocks.createWeeklyReportCorrection).not.toHaveBeenCalled();
  });
});

describe("a sent report the provider accepted", () => {
  it("offers a correction and no retry", () => {
    mocks.reports = [report({ sendDeliveredAt: "2026-08-13T22:00:00.000Z" })];
    render();
    expect(button("Retry send")).toBeUndefined();
    expect(button("Send correction")).toBeDefined();
  });

  it("uses the wording that fits a client who already has a copy", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.reports = [report({ sendDeliveredAt: "2026-08-13T22:00:00.000Z" })];
    render();
    await act(async () => {
      button("Send correction")!.click();
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/replaces the copy they already have/i));
  });
});

describe("a superseded version is never re-sent", () => {
  // THE STATE: v1 goes out Monday and its delivery fails. The PM issues a correction. v2 is sent and
  // DELIVERED on Tuesday, which stamps `superseded_by_id` on v1. v1 is now `sent`, superseded, and still
  // `sendDeliveredAt: null` — every predicate the Retry branch used to check is satisfied — and its
  // stored send request still carries the live share URL, because that is only dropped on delivery.
  //
  // Clicking Retry there emails a paying client the version they were already told was replaced, with
  // `isCorrection: false` so the message says nothing about it, linking to a page that then shows them a
  // superseded notice. Irreversible, and nothing on any dashboard reports it: the board's undelivered
  // query carries `superseded_by_id IS NULL`, so it is silent on this row by construction. History was
  // the one surface offering the action.
  function correctedWeek() {
    return [
      report({ id: "v2", version: 2, sendDeliveredAt: "2026-08-14T22:00:00.000Z" }),
      report({
        id: "v1",
        version: 1,
        supersededById: "v2",
        // The whole trap: undelivered, so the guard the button DID have passes.
        sendDeliveredAt: null,
        sendError: REJECTED_ERROR,
        sendAttempts: 3,
      }),
    ];
  }

  it("offers no Retry on the superseded version", () => {
    mocks.reports = correctedWeek();
    render();
    expect(button("Retry send")).toBeUndefined();
  });

  it("still offers the correction on the version that replaced it, so the row is not left dead", () => {
    // Guards against "fixed" by hiding every control on the week. The newest version keeps its action.
    mocks.reports = correctedWeek();
    render();
    expect(button("Send correction")).toBeDefined();
  });

  it("keeps Retry on an undelivered version nothing has replaced yet", () => {
    // The other direction, and the reason the predicate is `supersededById` rather than "a v2 exists":
    // superseding happens at SEND, so a v1 with an unsent v2 drafted beside it is still the version the
    // client is owed, and retrying it is exactly right. The board points its own Retry at v1 here too.
    mocks.reports = [
      report({ id: "v2", version: 2, status: "approved", sentAt: null, sendDeliveredAt: null }),
      report({ id: "v1", version: 1, supersededById: null, sendError: REJECTED_ERROR }),
    ];
    render();
    expect(button("Retry send")).toBeDefined();
  });
});

describe("only the newest version of a week may be corrected", () => {
  it("hides the button on an older version once a correction exists", () => {
    // A report is only marked superseded when its replacement is SENT, so a v1 with an unsent v2 sitting
    // beside it is still un-superseded — and used to be offered the button a second time, producing a v3
    // that leaves the week reporting a report the client already received. The server refuses that
    // outright; this stops the UI inviting it.
    mocks.reports = [
      report({ id: "v2", version: 2, status: "approved", sendDeliveredAt: null }),
      report({ id: "v1", version: 1, sendDeliveredAt: "2026-08-13T22:00:00.000Z" }),
    ];
    render();
    expect(button("Send correction")).toBeUndefined();
  });

  it("keeps it on the newest sent version", () => {
    mocks.reports = [
      report({ id: "v2", version: 2, sendDeliveredAt: "2026-08-14T22:00:00.000Z" }),
      report({
        id: "v1",
        version: 1,
        supersededById: "v2",
        sendDeliveredAt: "2026-08-13T22:00:00.000Z",
      }),
    ];
    render();
    expect(button("Send correction")).toBeDefined();
  });
});

/**
 * A BOUNCE IS THE ONE FAILURE THAT LOOKS LIKE A SUCCESS.
 *
 * `sendDeliveredAt` is SET on a bounced report — the provider accepted the message before the receiving
 * server refused it — so every predicate on this page that asks "did it get out" answered yes, and the
 * row rendered as an ordinary delivered week with a correction offered under the wording for a client who
 * already has their copy.
 */
describe("a report the provider reported as undeliverable", () => {
  it("says so on the row, rather than showing a plain Sent badge", () => {
    mocks.reports = [bounced()];
    render();
    expect(container.textContent).toMatch(/Bounced — bad address/);
  });

  it("shows the provider's own message on hover, so the PM can see WHY", () => {
    mocks.reports = [bounced()];
    render();
    const titles = Array.from(container.querySelectorAll("[title]")).map((el) => el.getAttribute("title"));
    expect(titles).toContain("550 5.1.1 user unknown");
  });

  it("warns that the client did NOT receive it, and does not send them to Retry", () => {
    // "Never reached the client — use Retry send instead" is the wrong advice here: a retry replays the
    // identical message to the identical address under the same idempotency key. Only a correction, sent
    // to a corrected address, can reach anybody.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.reports = [bounced()];
    render();
    button("Send correction")!.click();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/did not receive it/i));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/email address/i));
    expect(confirm).not.toHaveBeenCalledWith(expect.stringMatching(/Retry send instead/i));
  });

  it("still shows a delivered report as delivered — the control", () => {
    // Without this the assertions above would pass against a component that labelled everything a bounce.
    mocks.reports = [
      report({
        sendDeliveredAt: "2026-08-13T22:00:00.000Z",
        sendDeliveryStatus: "delivered",
        sendDeliveryStatusAt: "2026-08-13T22:04:00.000Z",
      }),
    ];
    render();
    expect(container.textContent).toMatch(/Delivered/);
    expect(container.textContent).not.toMatch(/Bounced/);
  });

  it("says NOTHING when no verdict has arrived", () => {
    // Silence is the honest answer. Every send made before the delivery webhook existed carries no tag,
    // so nothing will ever speak for it — and filling that in with "Delivered" would recreate exactly the
    // overclaim this feature removes.
    mocks.reports = [report({ sendDeliveredAt: "2026-08-13T22:00:00.000Z" })];
    render();
    expect(container.textContent).not.toMatch(/Delivered|Bounced|Marked as spam/);
  });
});

/**
 * WHAT "VIEW" IS FOR.
 *
 * The panel could render a week's contents and not one person who handled it — the names lived only on
 * the per-project audit endpoint, on a different tab. Somebody opening a past week is usually settling
 * "who sent this" or "who approved it", and the sheet answered neither.
 */
describe("the detail sheet", () => {
  /** Click View and let the detail promise settle, so assertions see the resolved sheet. */
  async function openFirstReport() {
    render();
    const view = button("View");
    expect(view).toBeTruthy();
    await act(async () => {
      view!.click();
    });
  }

  it("names who submitted, approved and sent the week, not only who drafted it", async () => {
    mocks.reports = [report()];
    mocks.fetchWeeklyReportDetail.mockResolvedValue(
      report({
        workCompleted: "Roof deck complete",
        authoredByName: "Steve Sanchez",
        authoredAt: "2026-08-13T14:00:00.000Z",
        submittedByName: "Steve Sanchez",
        submittedAt: "2026-08-13T15:00:00.000Z",
        reviewedByName: "Adam Sherwood",
        reviewedAt: "2026-08-13T16:00:00.000Z",
        sentByName: "Adam Sherwood",
        sentAt: "2026-08-13T17:00:00.000Z",
      }),
    );

    await openFirstReport();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Submitted");
    expect(text).toContain("Approved");
    expect(text).toContain("Adam Sherwood");
  });

  it("shows a step nobody has reached rather than hiding it", async () => {
    // The gap IS the information. A week that was never approved has to look different from one that
    // was — dropping the empty rows makes the two render identically, just at different heights.
    mocks.reports = [report()];
    mocks.fetchWeeklyReportDetail.mockResolvedValue(
      report({ status: "pending_review", reviewedByName: null, reviewedAt: null, sentByName: null, sentAt: null }),
    );

    await openFirstReport();

    expect(document.body.textContent).toContain("Approved");
    expect(document.body.textContent).toContain("Not yet");
  });

  it("says so when the report cannot be loaded, instead of closing again in silence", async () => {
    // THE BUG: `openDetail` had no catch, so a rejection left `detail` null and `detailLoading` false —
    // which is the sheet's own closed state. The panel opened, flashed and shut with no message, which
    // from the outside is indistinguishable from the button not being wired up at all.
    mocks.reports = [report()];
    mocks.fetchWeeklyReportDetail.mockRejectedValue(new Error("Weekly report not found"));

    await openFirstReport();

    const text = document.body.textContent ?? "";
    expect(text).toContain("could not be loaded");
    expect(text).toContain("Weekly report not found");
  });
});

describe("the row's overflow menu", () => {
  // GATED ON THE SERVER'S FLAGS, never on a role the browser reads for itself. `canEdit` depends on the
  // report's status and the project's two assignment slots as well as the role — a sent report is closed
  // to everyone, an approved one only to the PM — so a client-side re-derivation would eventually offer a
  // control the API refuses, which the user meets as a 403 on a button that looked live.
  function trigger(): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll("button")).find((element) =>
      element.getAttribute("aria-label")?.startsWith("More actions"),
    ) as HTMLButtonElement | undefined;
  }

  it("is not rendered at all for a reader who may do neither", () => {
    // An overflow button that opens onto nothing reads as a broken control, and for a rep — who can open
    // this whole tab and act on none of it — that would be every row on the page.
    mocks.reports = [report()];
    render();
    expect(trigger()).toBeUndefined();
  });

  it("appears once the server says this reader may edit", () => {
    mocks.reports = [report({ permissions: { canEdit: true, canDelete: false } })];
    render();
    expect(trigger()).toBeDefined();
  });

  it("appears once the server says this reader may delete", () => {
    mocks.reports = [report({ permissions: { canEdit: false, canDelete: true } })];
    render();
    expect(trigger()).toBeDefined();
  });

  async function menuLabels(): Promise<(string | undefined)[]> {
    await act(async () => {
      trigger()!.click();
    });
    return Array.from(document.querySelectorAll('[role="menuitem"]')).map((element) =>
      element.textContent?.trim(),
    );
  }

  // THE MENU'S EXISTENCE AND EACH ITEM'S ARE SEPARATE GATES, and only these two assert the second. The
  // reader who may do neither gets no menu at all, so an item that ignored its own flag would pass every
  // other test in this block — and hand a rep-shaped reader a control the API refuses.
  it("offers Edit alone when that is all the server allowed", async () => {
    mocks.reports = [report({ status: "draft", permissions: { canEdit: true, canDelete: false } })];
    render();
    const labels = await menuLabels();
    expect(labels).toContain("Edit report");
    expect(labels).not.toContain("Delete report");
  });

  it("offers Delete alone when that is all the server allowed", async () => {
    // The ordinary case for a sent report: leadership may remove it and nobody may edit it.
    mocks.reports = [report({ permissions: { canEdit: false, canDelete: true } })];
    render();
    const labels = await menuLabels();
    expect(labels).toContain("Delete report");
    expect(labels).not.toContain("Edit report");
  });

  it("offers Delete report, and opens the reason dialog rather than deleting on the click", async () => {
    // A row-destructive action that fires on the menu click is a one-click irreversible delete. The
    // dialog is what makes the reason mandatory — and the reason is the whole difference between a
    // removal somebody can account for and a row that quietly stopped existing.
    mocks.reports = [report({ status: "draft", permissions: { canEdit: false, canDelete: true } })];
    render();
    await act(async () => {
      trigger()!.click();
    });

    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (element) => element.textContent?.trim() === "Delete report",
    ) as HTMLElement | undefined;
    expect(item).toBeDefined();

    await act(async () => {
      item!.click();
    });
    expect(document.body.textContent).toContain("There is no undo");
  });

  it("offers Edit report, and opens the form on what the row already says", async () => {
    mocks.reports = [
      report({ status: "draft", workCompleted: "Framing on level 3", permissions: { canEdit: true, canDelete: false } }),
    ];
    render();
    await act(async () => {
      trigger()!.click();
    });

    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (element) => element.textContent?.trim() === "Edit report",
    ) as HTMLElement | undefined;
    expect(item).toBeDefined();

    await act(async () => {
      item!.click();
    });
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="Work completed"]');
    expect(textarea?.value).toBe("Framing on level 3");
  });
});
