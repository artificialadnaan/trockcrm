/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldPhoto } from "../lib/field-projects";
import { ReportBuilder } from "./ReportBuilder";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({ api: apiMock }));

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

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

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
});
