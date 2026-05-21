import { afterEach, describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:module");
});

async function importRenderer() {
  const module = await import("../../../src/modules/field/pdf-layout.js");
  return module.renderFieldPhotoReportPdf;
}

function buildCoverInput(photoCount = 0) {
  return {
    cover: {
      reportTitle: "Monarch Pass Treads",
      creatorName: "Adnaan Iqbal",
      companyName: "TRock Construction",
      reportDateLabel: "May 18, 2026",
      projectName: "Monarch Pass",
      photoCount,
    },
    sections: [],
  };
}

function buildSectionedInput() {
  return {
    cover: {
      reportTitle: "Monarch Pass Treads",
      creatorName: "Adnaan Iqbal",
      companyName: "TRock Construction",
      reportDateLabel: "May 18, 2026",
      projectName: "Monarch Pass",
      photoCount: 1,
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
        ],
      },
    ],
  };
}

function buildMultiPageInput() {
  return {
    cover: {
      reportTitle: "Monarch Pass Treads",
      creatorName: "Adnaan Iqbal",
      companyName: "TRock Construction",
      reportDateLabel: "May 18, 2026",
      projectName: "Monarch Pass",
      photoCount: 5,
    },
    sections: [
      {
        title: "Section 1",
        photos: Array.from({ length: 5 }, (_, index) => ({
          id: `photo-${index + 1}`,
          displayName: `Photo ${index + 1}`,
          description: `Inspection note ${index + 1}`,
          takenAt: "2026-05-01T12:00:00.000Z",
          createdAt: "2026-05-01T12:00:00.000Z",
          uploaderName: "Field User",
          projectName: "Monarch Pass",
          tags: ["roofing"],
          r2Key: null,
          externalUrl: null,
          externalThumbnailUrl: null,
          reportIndex: index + 1,
        })),
      },
    ],
  };
}

describe("field photo report pdf layout", () => {
  it("draws the cover logo on a branded contrast panel", async () => {
    const renderFieldPhotoReportPdf = await importRenderer();
    const roundedRectSpy = vi.spyOn(PDFDocument.prototype, "roundedRect");
    const imageSpy = vi.spyOn(PDFDocument.prototype, "image");

    await renderFieldPhotoReportPdf(buildCoverInput());

    expect(roundedRectSpy).toHaveBeenCalledWith(183, 322, 246, 234, 18);
    expect(imageSpy).toHaveBeenCalledWith(
      expect.any(Buffer),
      201,
      334,
      expect.objectContaining({
        fit: [210, 210],
        align: "center",
        valign: "center",
      })
    );
  });

  it("registers embedded Geist OTF fonts and uses them across the report by default", async () => {
    const renderFieldPhotoReportPdf = await importRenderer();
    const registerFontSpy = vi.spyOn(PDFDocument.prototype, "registerFont");
    const fontSpy = vi.spyOn(PDFDocument.prototype, "font");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await renderFieldPhotoReportPdf(buildSectionedInput());

    expect(registerFontSpy).toHaveBeenCalledWith(
      "Geist-Regular",
      expect.stringContaining("server/src/modules/field/assets/fonts/Geist-Regular.otf")
    );
    expect(registerFontSpy).toHaveBeenCalledWith(
      "Geist-Bold",
      expect.stringContaining("server/src/modules/field/assets/fonts/Geist-Bold.otf")
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(fontSpy).toHaveBeenCalledWith("Geist-Regular");
    expect(fontSpy).toHaveBeenCalledWith("Geist-Bold");
  });

  it("falls back to Helvetica if the embedded Geist OTF assets are unavailable", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: () => false,
      };
    });

    const renderFieldPhotoReportPdf = await importRenderer();
    const fontSpy = vi.spyOn(PDFDocument.prototype, "font");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const buffer = await renderFieldPhotoReportPdf(buildCoverInput());

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(warnSpy).toHaveBeenCalledWith(
      "[field-report-pdf] embedded Geist OTF assets are unavailable; using Helvetica fallback."
    );
    expect(fontSpy).toHaveBeenCalledWith("Helvetica-Bold");
  });

  it("falls back to Helvetica if pdfkit rejects the embedded Geist OTF fonts", async () => {
    const renderFieldPhotoReportPdf = await importRenderer();
    const registerFontSpy = vi.spyOn(PDFDocument.prototype, "registerFont").mockImplementationOnce(() => {
      throw new Error("bad font");
    });
    const fontSpy = vi.spyOn(PDFDocument.prototype, "font");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const buffer = await renderFieldPhotoReportPdf(buildCoverInput());

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(registerFontSpy).toHaveBeenCalledWith(
      "Geist-Regular",
      expect.stringContaining("server/src/modules/field/assets/fonts/Geist-Regular.otf")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[field-report-pdf] failed to register embedded Geist OTF fonts with pdfkit; using Helvetica fallback.",
      expect.any(Error)
    );
    expect(fontSpy).toHaveBeenCalledWith("Helvetica-Bold");
  });

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

  it("renders multi-page photo sections without layout errors", async () => {
    const renderFieldPhotoReportPdf = await importRenderer();

    const buffer = await renderFieldPhotoReportPdf(buildMultiPageInput());

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(buffer.byteLength).toBeGreaterThan(1500);
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

    const buffer = await renderFieldPhotoReportPdf(buildCoverInput());

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("logs an explicit error if pdfkit rejects the embedded logo", async () => {
    const renderFieldPhotoReportPdf = await importRenderer();
    const imageSpy = vi.spyOn(PDFDocument.prototype, "image").mockImplementationOnce(() => {
      throw new Error("bad image");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const buffer = await renderFieldPhotoReportPdf(buildCoverInput());

    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(imageSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[field-report-pdf] failed to embed T Rock logo",
      expect.any(Error)
    );
  });
});
