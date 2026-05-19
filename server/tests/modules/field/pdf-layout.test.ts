import { describe, expect, it } from "vitest";
import { renderFieldPhotoReportPdf } from "../../../src/modules/field/pdf-layout.js";

describe("field photo report pdf layout", () => {
  it("renders a valid branded pdf buffer", async () => {
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
  });
});
