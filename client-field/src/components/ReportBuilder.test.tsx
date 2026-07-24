/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldPhoto } from "../lib/field-projects";
import { ReportBuilder } from "./ReportBuilder";

const apiMock = vi.hoisted(() => vi.fn());
const getVoiceConfigMock = vi.hoisted(() => vi.fn());
const transcribeMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({ api: apiMock }));

vi.mock("../lib/photo-dictation", () => ({
  getVoiceTranscriptionConfig: getVoiceConfigMock,
  transcribeDescriptionAudio: transcribeMock,
}));

// Mock the child recorder so tests can drive its callbacks without a real MediaRecorder (jsdom has none):
// one button fires onTranscript, two toggle the busy state the parent uses to guard Generate.
vi.mock("./VoiceRecorder", async () => {
  const ReactModule = await import("react");
  return {
    VoiceRecorder: ({ disabled, onTranscript, onBusyChange }: {
      disabled?: boolean;
      onTranscript: (text: string) => void;
      onBusyChange?: (busy: boolean) => void;
    }) =>
      ReactModule.createElement(
        ReactModule.Fragment,
        null,
        ReactModule.createElement(
          "button",
          { type: "button", "data-testid": "mock-voice", disabled, onClick: () => onTranscript("dictated summary") },
          "voice",
        ),
        ReactModule.createElement(
          "button",
          { type: "button", "data-testid": "mock-voice-empty", disabled, onClick: () => onTranscript("   ") },
          "voice-empty",
        ),
        ReactModule.createElement(
          "button",
          { type: "button", "data-testid": "mock-voice-busy-on", onClick: () => onBusyChange?.(true) },
          "busy-on",
        ),
        ReactModule.createElement(
          "button",
          { type: "button", "data-testid": "mock-voice-busy-off", onClick: () => onBusyChange?.(false) },
          "busy-off",
        ),
      ),
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const photos: FieldPhoto[] = [
  {
    id: "photo-1",
    displayName: "Front elevation",
    description: "Front elevation crack",
    takenAt: "2026-05-10T10:00:00.000Z",
    createdAt: "2026-05-10T10:00:00.000Z",
    uploaderName: "Adnaan",
    imageUrl: "https://example.com/front.jpg",
    tags: ["roofing", "urgent"],
    category: "photo",
    photoCategory: "damage",
    subcategory: null,
    mimeType: "image/jpeg",
    fileSizeBytes: 123,
    fileExtension: ".jpg",
    dealId: "deal-1",
    leadId: null,
    uploadedBy: "user-1",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: null,
    addressSource: null,
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
  },
  {
    id: "photo-2",
    displayName: "Rear elevation",
    description: "Rear elevation note",
    takenAt: "2026-05-11T10:00:00.000Z",
    createdAt: "2026-05-11T10:00:00.000Z",
    uploaderName: "Adnaan",
    imageUrl: "https://example.com/rear.jpg",
    tags: ["safety"],
    category: "photo",
    photoCategory: "safety",
    subcategory: null,
    mimeType: "image/jpeg",
    fileSizeBytes: 123,
    fileExtension: ".jpg",
    dealId: "deal-1",
    leadId: null,
    uploadedBy: "user-1",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: null,
    addressSource: null,
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
  },
];

beforeEach(() => {
  // Default: transcription configured (mic shown). Individual tests override to false.
  getVoiceConfigMock.mockResolvedValue({ configured: true });
  transcribeMock.mockResolvedValue({ transcript: "" });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
  getVoiceConfigMock.mockReset();
  transcribeMock.mockReset();
});

function clickButton(node: HTMLElement, text: string) {
  Array.from(node.querySelectorAll("button")).find((button) => button.textContent === text)?.click();
}

// React tracks controlled <textarea>/<input> value via the native setter, so setting `.value` directly is
// ignored — we must go through the prototype setter and dispatch a bubbling input event.
function setControlledValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function execSummaryInput(node: HTMLElement) {
  return node.querySelector('[data-testid="executive-summary-input"]') as HTMLTextAreaElement | null;
}

// Type into the summary AND wait for React to commit it before returning. Without the commit-wait, an
// immediately-following action (clicking the mic to dictate) can read a not-yet-committed empty summary — a
// test-only race (a real user types long before dictating). Mirrors the app's controlled-value flow.
async function setSummary(node: HTMLElement, value: string) {
  const input = execSummaryInput(node);
  expect(input).toBeTruthy();
  setControlledValue(input!, value);
  await vi.waitFor(() => expect(execSummaryInput(node)!.value).toBe(value));
}

const previewResponse = {
  cover: {
    reportTitle: "Atlas Point Photo Report",
    creatorName: "Adnaan Iqbal",
    companyName: "TRock Construction",
    reportDateLabel: "May 18, 2026",
    projectName: "Atlas Point",
    photoCount: 1,
  },
  sections: [
    {
      id: "section-1",
      title: "Tag: roofing",
      photos: [{
        id: "photo-1",
        displayName: "Front elevation",
        description: "Front elevation crack",
        takenAt: "2026-05-10T10:00:00.000Z",
        createdAt: "2026-05-10T10:00:00.000Z",
        uploaderName: "Adnaan",
        imageUrl: "https://example.com/front.jpg",
        tags: ["roofing", "urgent"],
        projectName: "Atlas Point",
      }],
    },
  ],
};

async function gotoEditStep(node: HTMLElement) {
  apiMock.mockResolvedValueOnce(previewResponse);
  await vi.waitFor(() => expect(node.textContent).toContain("Front elevation crack"));
  clickButton(node, "Select all visible");
  await vi.waitFor(() => expect(node.textContent).toContain("2 selected"));
  clickButton(node, "Continue");
  await vi.waitFor(() => expect(node.textContent).toContain("Edit Report"));
}

function renderBuilder(props?: Partial<React.ComponentProps<typeof ReportBuilder>>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <ReportBuilder
      isOpen
      projectId="deal-1"
      projectName="Atlas Point"
      creatorName="Adnaan Iqbal"
      photos={[...photos]}
      onClose={vi.fn()}
      onGenerated={vi.fn()}
      {...props}
    />
  );
  return container;
}

describe("ReportBuilder", () => {
  it("renders tag and date selection controls on the selection step", async () => {
    const node = renderBuilder();

    await vi.waitFor(() => expect(node.textContent).toContain("Generate Report"));
    expect(node.querySelector('img[alt="T Rock Construction logo"]')).toBeTruthy();
    expect(node.querySelector('[data-brand-logo-surface="dark"]')).toBeTruthy();
    expect(node.textContent).toContain("Front elevation crack");
    expect(node.textContent).toContain("Rear elevation note");
    expect(node.textContent).toContain("#roofing");
    expect(node.textContent).toContain("#urgent");
    expect(node.querySelectorAll('input[type="date"]').length).toBe(2);
  });

  it("renders each selectable photo's thumbnail in the selection grid", async () => {
    // Regression guard: the report-builder grid must actually surface thumbnails. It previously went blank —
    // native loading="lazy" never fired inside the modal's nested scroll container — so photos load through
    // LazyThumb now. (jsdom has no IntersectionObserver, so LazyThumb's eager fallback renders the <img>.)
    const node = renderBuilder();
    await vi.waitFor(() => expect(node.textContent).toContain("Front elevation crack"));
    expect(node.querySelector('img[src="https://example.com/front.jpg"]')).toBeTruthy();
    expect(node.querySelector('img[src="https://example.com/rear.jpg"]')).toBeTruthy();
  });

  it("walks the user through preview and PDF generation", async () => {
    const onGenerated = vi.fn();
    apiMock
      .mockResolvedValueOnce({
        cover: {
          reportTitle: "Atlas Point Photo Report",
          creatorName: "Adnaan Iqbal",
          companyName: "TRock Construction",
          reportDateLabel: "May 18, 2026",
          projectName: "Atlas Point",
          photoCount: 1,
        },
        sections: [
          {
            id: "section-1",
            title: "Tag: roofing",
            photos: [{
              id: "photo-1",
              displayName: "Front elevation",
              description: "Front elevation crack",
              takenAt: "2026-05-10T10:00:00.000Z",
              createdAt: "2026-05-10T10:00:00.000Z",
              uploaderName: "Adnaan",
              imageUrl: "https://example.com/front.jpg",
              tags: ["roofing", "urgent"],
              projectName: "Atlas Point",
            }],
          },
        ],
      })
      .mockResolvedValueOnce({
        report: {
          id: "report-1",
          title: "Atlas Point Photo Report",
          pdfUrl: "https://example.com/report.pdf",
        },
      });

    const node = renderBuilder({ onGenerated });

    await vi.waitFor(() => expect(node.textContent).toContain("Front elevation crack"));
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Select all visible")?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("2 selected"));
    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Continue")?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("Edit Report"));
    expect(apiMock).toHaveBeenNthCalledWith(1, "/field/reports/preview", {
      method: "POST",
      json: { projectId: "deal-1", photoIds: ["photo-1", "photo-2"], groupBy: "tag" },
    });

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Generate PDF")?.click();

    await vi.waitFor(() => expect(apiMock).toHaveBeenNthCalledWith(2, "/field/reports/generate", expect.objectContaining({
      method: "POST",
      json: expect.objectContaining({
        projectId: "deal-1",
        reportTitle: "Atlas Point Photo Report",
      }),
    })));
    await vi.waitFor(() => expect(onGenerated).toHaveBeenCalled());
    await vi.waitFor(() => expect(node.querySelector('a[href="https://example.com/report.pdf"]')).toBeTruthy());
    expect(node.querySelector('a[href="https://example.com/report.pdf"]')?.textContent ?? "").toContain("Open Atlas Point Photo Report");
  });

  it("includes a trimmed executive summary in the generate payload", async () => {
    const node = renderBuilder();
    await gotoEditStep(node);

    await setSummary(node, "  Roof replaced; site cleared and inspected.  ");

    apiMock.mockResolvedValueOnce({ report: { id: "report-1", title: "T", pdfUrl: "https://example.com/r.pdf" } });
    clickButton(node, "Generate PDF");

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/field/reports/generate", expect.objectContaining({
      method: "POST",
      json: expect.objectContaining({ executiveSummary: "Roof replaced; site cleared and inspected." }),
    })));
  });

  it("sends a null executive summary when the field is blank", async () => {
    const node = renderBuilder();
    await gotoEditStep(node);

    await setSummary(node, "   ");

    apiMock.mockResolvedValueOnce({ report: { id: "report-1", title: "T", pdfUrl: "https://example.com/r.pdf" } });
    clickButton(node, "Generate PDF");

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/field/reports/generate", expect.objectContaining({
      json: expect.objectContaining({ executiveSummary: null }),
    })));
  });

  it("appends a dictated transcript to the existing summary text", async () => {
    const node = renderBuilder();
    await gotoEditStep(node);

    await setSummary(node, "Existing note.");
    await vi.waitFor(() => expect(node.querySelector('[data-testid="mock-voice"]')).toBeTruthy());
    (node.querySelector('[data-testid="mock-voice"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(execSummaryInput(node)!.value).toBe("Existing note. dictated summary"));
  });

  it("ignores an empty/whitespace transcript instead of adding a trailing space", async () => {
    const node = renderBuilder();
    await gotoEditStep(node);

    await setSummary(node, "Existing note.");
    await vi.waitFor(() => expect(node.querySelector('[data-testid="mock-voice-empty"]')).toBeTruthy());
    (node.querySelector('[data-testid="mock-voice-empty"]') as HTMLButtonElement).click();

    // Give any errant state update a chance to land, then assert the summary is untouched (no trailing space).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execSummaryInput(node)!.value).toBe("Existing note.");
  });

  it("hides the voice recorder until the probe confirms transcription is configured, and keeps it hidden when it is not", async () => {
    // A deferred probe proves the mic is gated on the resolved config — not shown before, nor after a false result.
    let resolveConfig!: (value: { configured: boolean }) => void;
    getVoiceConfigMock.mockReturnValue(new Promise<{ configured: boolean }>((resolve) => { resolveConfig = resolve; }));

    const node = renderBuilder();
    await gotoEditStep(node);

    // Before the probe resolves the mic must not be shown.
    expect(node.querySelector('[data-testid="mock-voice"]')).toBeFalsy();

    resolveConfig({ configured: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Still hidden after a false result.
    expect(node.querySelector('[data-testid="mock-voice"]')).toBeFalsy();
  });

  it("renders the voice recorder when transcription is configured", async () => {
    getVoiceConfigMock.mockResolvedValue({ configured: true });
    const node = renderBuilder();
    await gotoEditStep(node);

    await vi.waitFor(() => expect(node.querySelector('[data-testid="mock-voice"]')).toBeTruthy());
  });

  it("clamps the appended summary to 5000 characters", async () => {
    const node = renderBuilder();
    await gotoEditStep(node);

    await setSummary(node, "a".repeat(4995));
    (node.querySelector('[data-testid="mock-voice"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(execSummaryInput(node)!.value.length).toBe(5000));
  });

  it("blocks Generate PDF while a dictation is transcribing, then re-enables it when it finishes", async () => {
    const node = renderBuilder();
    await gotoEditStep(node);

    (node.querySelector('[data-testid="mock-voice-busy-on"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const generate = Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Generate PDF");
      expect(generate).toBeTruthy();
      expect((generate as HTMLButtonElement).disabled).toBe(true);
    });

    (node.querySelector('[data-testid="mock-voice-busy-off"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const generate = Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Generate PDF");
      expect((generate as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
