import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { FieldPhoto } from "../../api/types";

jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return { SafeAreaView: ({ children, ...p }: any) => <View {...p}>{children}</View> };
});
jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return { Image: (p: any) => <View {...p} /> };
});
jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ fetcher: jest.fn(), user: { id: "u1" } }) }));
jest.mock("../VoiceRecorder", () => ({ VoiceRecorder: () => null }));

const mockPreviewReport = jest.fn();
const mockGenerateReport = jest.fn();
const mockStartAiReport = jest.fn();
const mockGetAiReportStatus = jest.fn();
jest.mock("../../api/endpoints", () => ({
  previewReport: (...args: unknown[]) => mockPreviewReport(...args),
  generateReport: (...args: unknown[]) => mockGenerateReport(...args),
  startAiReport: (...args: unknown[]) => mockStartAiReport(...args),
  getAiReportStatus: (...args: unknown[]) => mockGetAiReportStatus(...args),
}));

import { ReportBuilder } from "../ReportBuilder";

function galleryPhoto(id: string, name: string): FieldPhoto {
  return {
    id,
    category: "photo",
    photoCategory: "construction",
    subcategory: null,
    displayName: name,
    mimeType: "image/jpeg",
    fileSizeBytes: null,
    fileExtension: "jpg",
    dealId: "d1",
    leadId: null,
    description: null,
    tags: [],
    takenAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    uploadedBy: "u1",
    uploaderName: "Tester",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: null,
    addressSource: null,
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
    imageUrl: `https://r2.example/${id}.jpg`,
    fullImageUrl: `https://r2.example/${id}-full.jpg`,
  };
}

const PHOTOS = [galleryPhoto("p1", "First"), galleryPhoto("p2", "Second")];

const AI_REPORT = { id: "file-1", title: "Tides Condition Assessment", pdfUrl: "https://r2/signed.pdf", expiresAt: null, createdAt: "" };

function renderBuilder(overrides: Partial<React.ComponentProps<typeof ReportBuilder>> = {}) {
  const props = { visible: true, onClose: jest.fn(), projectId: "d1", photos: PHOTOS, onGenerated: jest.fn(), onLeftRunning: jest.fn(), ...overrides };
  return { ui: render(<ReportBuilder {...props} />), props };
}

/** Advance past one poll interval and let the resulting promise chain settle. */
async function tickPoll() {
  await act(async () => {
    jest.advanceTimersByTime(3_000);
  });
}

/** Select every photo and step into the AI focus screen. */
async function openFocusStep(ui: ReturnType<typeof render>) {
  await act(async () => {
    fireEvent.press(ui.getByText("Select all"));
  });
  await act(async () => {
    fireEvent.press(ui.getByLabelText("AI Report"));
  });
  await waitFor(() => expect(ui.queryByText("What should this report focus on?")).not.toBeNull());
}

/** Fire the generate button on the focus screen. */
async function pressGenerate(ui: ReturnType<typeof render>) {
  await act(async () => {
    fireEvent.press(ui.getByLabelText("Generate AI report"));
  });
}

describe("ReportBuilder AI report", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStartAiReport.mockReset();
    mockGetAiReportStatus.mockReset();
    mockPreviewReport.mockReset();
    mockStartAiReport.mockResolvedValue({ runId: "run-1", status: "queued" });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("sits next to Preview report and is disabled until photos are selected", () => {
    const { ui } = renderBuilder();
    const aiButton = ui.getByLabelText("AI Report");
    expect(ui.queryByText("Preview report")).not.toBeNull();
    expect(aiButton.props.accessibilityState?.disabled).toBe(true);
  });

  it("disables the AI action past the photo cap, and says why", async () => {
    // The server rejects >60. Letting the user through the whole focus step first, only to be refused at
    // generation, wastes their time — and the cap must NOT restrict the human preview flow.
    const many = Array.from({ length: 61 }, (_, i) => galleryPhoto(`p${i}`, `Photo ${i}`));
    const { ui } = renderBuilder({ photos: many });
    await act(async () => {
      fireEvent.press(ui.getByText("Select all"));
    });

    expect(ui.getByLabelText("AI Report").props.accessibilityState?.disabled).toBe(true);
    expect(ui.queryByText(/deselect 1 to use it/i)).not.toBeNull();
    // Preview is unaffected — it has no such cap.
    expect(ui.getByLabelText("Preview report").props.accessibilityState?.disabled).toBeFalsy();
  });

  it("asks for a focus before generating rather than firing straight off the grid", async () => {
    const { ui } = renderBuilder();
    await openFocusStep(ui);
    // Stepping into the focus screen must not have queued anything yet.
    expect(mockStartAiReport).not.toHaveBeenCalled();
    expect(ui.queryByText(/Leave it blank/)).not.toBeNull();
  });

  it("sends the focus prompt the user typed", async () => {
    const { ui } = renderBuilder();
    await openFocusStep(ui);
    await act(async () => {
      fireEvent.changeText(
        ui.getByPlaceholderText(/Roof drainage and flashing only/),
        "  Roof drainage only  ",
      );
    });
    await pressGenerate(ui);

    await waitFor(() =>
      expect(mockStartAiReport).toHaveBeenCalledWith(expect.anything(), {
        projectId: "d1",
        photoIds: ["p1", "p2"],
        focusPrompt: "Roof drainage only",
      }),
    );
  });

  it("omits the focus entirely when left blank", async () => {
    // Blank is a first-class choice — the server reads a missing focus as "general director's read".
    const { ui } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);

    await waitFor(() =>
      expect(mockStartAiReport).toHaveBeenCalledWith(expect.anything(), {
        projectId: "d1",
        photoIds: ["p1", "p2"],
        focusPrompt: undefined,
      }),
    );
  });

  it("enqueues the selected photos and opens the finished report", async () => {
    mockGetAiReportStatus
      .mockResolvedValueOnce({ runId: "run-1", status: "running" })
      .mockResolvedValueOnce({ runId: "run-1", status: "succeeded", report: AI_REPORT });

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);

    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());

    await tickPoll(); // first poll → still running
    expect(props.onGenerated).not.toHaveBeenCalled();
    await tickPoll(); // second poll → succeeded

    // Reuses the same success handler as "Generate PDF" — the parent shows the toast, refetches the report
    // list and opens the PDF, so that behaviour lives in exactly one place.
    await waitFor(() => expect(props.onGenerated).toHaveBeenCalledWith(AI_REPORT));
  });

  it("rides out a dropped status poll instead of reporting a false failure", async () => {
    // Jobsite LTE drops individual requests during a 60-90s wait. Treating one as terminal would tell the
    // user their report failed while it is still running and about to file.
    mockGetAiReportStatus
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockRejectedValueOnce(new Error("Request timed out"))
      .mockResolvedValueOnce({ runId: "run-1", status: "succeeded", report: AI_REPORT });

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());

    await tickPoll();
    await tickPoll();
    expect(props.onGenerated).not.toHaveBeenCalled();
    await tickPoll();

    await waitFor(() => expect(props.onGenerated).toHaveBeenCalledWith(AI_REPORT));
  });

  it("gives up after a sustained outage rather than polling blind", async () => {
    mockGetAiReportStatus.mockRejectedValue(new Error("Network request failed"));
    const { ui } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());

    for (let i = 0; i < 6; i += 1) await tickPoll();
    await waitFor(() => expect(ui.queryByText("Network request failed")).not.toBeNull());
  });

  it("hands the run off when polling is abandoned after a sustained outage", async () => {
    // Giving up on the POLL is not giving up on the RUN. The generation is still going, and the Generate
    // button is live again — so without a hand-off nothing refreshes the finished report, and a retry buys a
    // second paid assessment for work that already completed.
    mockGetAiReportStatus.mockRejectedValue(new Error("Network request failed"));
    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());

    for (let i = 0; i < 6; i += 1) await tickPoll();

    await waitFor(() => expect(props.onLeftRunning).toHaveBeenCalledWith("run-1"));
    expect(props.onLeftRunning).toHaveBeenCalledTimes(1);
  });

  it("does not open the report when the sheet was closed while the poll was in flight", async () => {
    // The cancel check has to run AFTER the await too — a status request can be in flight for seconds.
    let release: (v: unknown) => void = () => {};
    mockGetAiReportStatus.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());
    await tickPoll(); // poll fires and hangs

    await act(async () => {
      fireEvent.press(ui.getByText("Back")); // focus step → select
    });
    await act(async () => {
      fireEvent.press(ui.getByText("Cancel")); // select → close(), which stops polling
    });
    await act(async () => {
      release({ runId: "run-1", status: "succeeded", report: AI_REPORT });
    });

    expect(props.onGenerated).not.toHaveBeenCalled();
  });

  it("does not strand the progress text when the sheet is closed during the enqueue", async () => {
    // close() runs reset(), which clears aiProgress and invalidates the token — but the stale continuation
    // used to write "Reviewing …" back straight AFTER that, and the `finally` deliberately leaves stale
    // state alone. The text then survived on the sheet with nothing actually polling behind it.
    let release: (v: unknown) => void = () => {};
    mockStartAiReport.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { ui } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());

    // Close while the ENQUEUE (not the poll) is still in flight.
    await act(async () => { fireEvent.press(ui.getByText("Back")); });
    await act(async () => { fireEvent.press(ui.getByText("Cancel")); });
    await act(async () => { release({ runId: "run-1" }); });

    expect(ui.queryByText(/Reviewing/)).toBeNull();
  });

  it("hands a still-running generation back to the owner when the sheet is closed", async () => {
    // The job carries on server-side and files its report, but nothing in this sheet is watching for it any
    // more — and the project screen's report list has no polling interval. Without the hand-off the report
    // simply never appears until a manual pull-to-refresh, despite the UI promising it will.
    mockGetAiReportStatus.mockResolvedValue({ runId: "run-1", status: "running" });

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());
    await tickPoll(); // one poll, still running

    await act(async () => { fireEvent.press(ui.getByText("Back")); });
    await act(async () => { fireEvent.press(ui.getByText("Cancel")); });

    // Named, not just signalled: only the run itself says whether THIS report landed.
    expect(props.onLeftRunning).toHaveBeenCalledTimes(1);
    expect(props.onLeftRunning).toHaveBeenCalledWith("run-1");
  });

  it("hands off a run that was enqueued after the sheet had already closed", async () => {
    // Closing DURING the enqueue: reset() runs while no run id exists yet, so it has nothing to hand off —
    // but the server still commits a run. Without a hand-off at the response, a real generation is left with
    // neither the foreground loop nor the background watcher following it.
    let release: (v: unknown) => void = () => {};
    mockStartAiReport.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());

    await act(async () => { fireEvent.press(ui.getByText("Back")); });
    await act(async () => { fireEvent.press(ui.getByText("Cancel")); });
    // The enqueue only now comes back, with a run the server has committed.
    await act(async () => { release({ runId: "run-late" }); });

    expect(props.onLeftRunning).toHaveBeenCalledWith("run-late");
  });

  it("does NOT hand off a generation that already finished", async () => {
    // The counterweight: onGenerated already refreshes the list, so firing the hand-off here would start a
    // pointless background wait after every successful report.
    mockGetAiReportStatus.mockResolvedValue({ runId: "run-1", status: "succeeded", report: AI_REPORT });

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());
    await tickPoll();

    await waitFor(() => expect(props.onGenerated).toHaveBeenCalled());
    expect(props.onLeftRunning).not.toHaveBeenCalled();
  });

  it("a stale poll loop cannot resurrect itself once a new run has started", async () => {
    // With a shared boolean, a newly started report set the flag back to true while an OLD loop was still
    // resolving — the stale loop then resumed as current and could open the previous PDF, or clear the new
    // run's spinner in its own `finally`. A per-run token makes the old loop inert.
    let releaseFirst: (v: unknown) => void = () => {};
    mockGetAiReportStatus.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = resolve; }),
    );

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());
    await tickPoll(); // first loop's status request is now in flight and hanging

    // Close the sheet, then start a SECOND report — this bumps the token.
    await act(async () => { fireEvent.press(ui.getByText("Back")); });
    await act(async () => { fireEvent.press(ui.getByText("Cancel")); });
    mockGetAiReportStatus.mockResolvedValue({ runId: "run-2", status: "running" });
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalledTimes(2));

    // Now let the FIRST loop's request resolve as a success. It must be ignored entirely.
    await act(async () => {
      releaseFirst({ runId: "run-1", status: "succeeded", report: AI_REPORT });
    });

    expect(props.onGenerated).not.toHaveBeenCalled();
    // ...and the live run is still shown as in progress, not silently cleared by the stale loop.
    expect(ui.queryByText(/Reviewing 2 photos/)).not.toBeNull();
  });

  it("surfaces a failed run instead of polling forever", async () => {
    mockGetAiReportStatus.mockResolvedValue({ runId: "run-1", status: "failed", error: "Claude request timed out." });

    const { ui, props } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());
    await tickPoll();

    await waitFor(() => expect(ui.queryByText("Claude request timed out.")).not.toBeNull());
    expect(props.onGenerated).not.toHaveBeenCalled();

    // Polling stopped — no further status calls once the run reached a terminal state.
    const callsAfterFailure = mockGetAiReportStatus.mock.calls.length;
    await tickPoll();
    expect(mockGetAiReportStatus).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it("shows the enqueue error and does not start polling", async () => {
    mockStartAiReport.mockRejectedValue(new Error("AI reports are not available right now."));

    const { ui } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);

    await waitFor(() => expect(ui.queryByText("AI reports are not available right now.")).not.toBeNull());
    expect(mockGetAiReportStatus).not.toHaveBeenCalled();
  });

  it("does not put the Preview button into a spinner for an AI request", async () => {
    // `busy` and `aiBusy` are separate flags; sharing one would spin the wrong control.
    mockGetAiReportStatus.mockResolvedValue({ runId: "run-1", status: "running" });
    const { ui } = renderBuilder();
    await openFocusStep(ui);
    await pressGenerate(ui);
    await waitFor(() => expect(mockStartAiReport).toHaveBeenCalled());

    // Back out to the grid: Preview must still be a live button, not stuck mid-spinner from the AI run.
    await act(async () => {
      fireEvent.press(ui.getByText("Back"));
    });
    expect(ui.queryByText("Preview report")).not.toBeNull();
  });

  it("returns to the photo grid from the focus screen without losing the selection", async () => {
    const { ui } = renderBuilder();
    await openFocusStep(ui);
    await act(async () => {
      fireEvent.press(ui.getByText("Back"));
    });
    await waitFor(() => expect(ui.queryByText("2 selected")).not.toBeNull());
    expect(mockStartAiReport).not.toHaveBeenCalled();
  });
});
