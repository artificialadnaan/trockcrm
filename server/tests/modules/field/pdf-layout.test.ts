import { afterEach, describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importRenderer() {
  const module = await import("../../../src/modules/field/pdf-layout.js");
  return module.renderFieldPhotoReportPdf;
}

describe("field photo report pdf layout", () => {
  it("renders a valid branded pdf buffer", async () => {
    const renderFieldPhotoReportPdf = await importRenderer();
    const buffer = await renderFieldPhotoReportPdf({
      cover: {
        reportTitle: "Monarch Pass Treads",
        creatorName: "Adnaan Iqbal",
        companyName: "TRock Construction",
        reportDateLabel: "May 18, 2026",
        projectName: "Monarch Pass",
        photoCount: 2,
      },
      sections: [
        {
          title: "Section 1",
          photos: [
            {
              id: "photo-1",
              displayName: "North slope detail",
              description: "Underside angle of sagging stringer.",
              takenAt: "2026-05-01T12:00:00.000Z",
              createdAt: "2026-05-01T12:00:00.000Z",
              uploaderName: "Field User",
              projectName: "Monarch Pass",
              tags: ["roofing"],
              r2Key: null,
              externalUrl: null,
              externalThumbnailUrl: null,
              reportIndex: 1,
            },
            {
              id: "photo-2",
              displayName: "Walk pad",
              description: "Walk pad condition noted near access hatch.",
              takenAt: "2026-05-02T12:00:00.000Z",
              createdAt: "2026-05-02T12:00:00.000Z",
              uploaderName: "Field User",
              projectName: "Monarch Pass",
              tags: ["safety"],
              r2Key: null,
              externalUrl: null,
              externalThumbnailUrl: null,
              reportIndex: 2,
            },
          ],
        },
      ],
    });

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(buffer.byteLength).toBeGreaterThan(1000);
    expect(buffer.toString("latin1")).toContain("PDFKit");
    expect(buffer.toString("latin1")).not.toContain("T ROCK");
  });

  it("still embeds the logo when filesystem logo paths are unavailable", async () => {
    const readFileMock = vi.fn().mockRejectedValue(new Error("ENOENT"));
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        readFile: readFileMock,
      };
    });
    const renderFieldPhotoReportPdf = await importRenderer();

    const buffer = await renderFieldPhotoReportPdf({
      cover: {
        reportTitle: "Monarch Pass Treads",
        creatorName: "Adnaan Iqbal",
        companyName: "TRock Construction",
        reportDateLabel: "May 18, 2026",
        projectName: "Monarch Pass",
        photoCount: 0,
      },
      sections: [],
    });

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("logs an explicit error if pdfkit rejects the embedded logo", async () => {
    const renderFieldPhotoReportPdf = await importRenderer();
    const imageSpy = vi.spyOn(PDFDocument.prototype, "image").mockImplementationOnce(() => {
      throw new Error("bad image");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const buffer = await renderFieldPhotoReportPdf({
      cover: {
        reportTitle: "Monarch Pass Treads",
        creatorName: "Adnaan Iqbal",
        companyName: "TRock Construction",
        reportDateLabel: "May 18, 2026",
        projectName: "Monarch Pass",
        photoCount: 0,
      },
      sections: [],
    });

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(imageSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[field-report-pdf] failed to embed T Rock logo",
      expect.any(Error)
    );
  });
});
