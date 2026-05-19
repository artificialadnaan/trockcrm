import { beforeEach, describe, expect, it, vi } from "vitest";

const projectMocks = vi.hoisted(() => ({
  assertActiveFieldProject: vi.fn(),
  listFieldProjectPhotos: vi.fn(),
}));

const r2Mocks = vi.hoisted(() => ({
  putObject: vi.fn(),
  generateDownloadUrl: vi.fn(),
  deleteObject: vi.fn(),
}));

const filesMocks = vi.hoisted(() => ({
  getFileById: vi.fn(),
  getFileDownloadUrl: vi.fn(),
}));

const pdfMocks = vi.hoisted(() => ({
  renderFieldPhotoReportPdf: vi.fn(),
}));

vi.mock("../../../src/modules/field/projects-service.js", () => projectMocks);
vi.mock("../../../src/lib/r2-client.js", () => r2Mocks);
vi.mock("../../../src/modules/files/service.js", () => filesMocks);
vi.mock("../../../src/modules/field/pdf-layout.js", () => pdfMocks);

const {
  previewFieldPhotoReport,
  generateFieldPhotoReport,
  listFieldProjectReports,
  getFieldProjectReportDownload,
} = await import("../../../src/modules/field/photo-reports-service.js");

const access = { userId: "user-1", userRole: "admin" } as const;

function createDb() {
  return {
    select: vi.fn(),
    insert: vi.fn(),
  } as any;
}

describe("photo reports service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    r2Mocks.deleteObject.mockResolvedValue(undefined);
    projectMocks.assertActiveFieldProject.mockResolvedValue({
      id: "deal-1",
      name: "Roof Repair",
      dealNumber: "TR-1",
    });
    projectMocks.listFieldProjectPhotos.mockResolvedValue({
      photos: [
        {
          id: "photo-1",
          displayName: "North slope",
          description: "North slope detail",
          takenAt: "2026-05-01T12:00:00.000Z",
          createdAt: "2026-05-01T12:00:00.000Z",
          uploaderName: "Field User",
          imageUrl: "https://example.test/photo-1.jpg",
          tags: ["roofing", "urgent"],
        },
        {
          id: "photo-2",
          displayName: "Walk pad",
          description: "Walk pad photo",
          takenAt: "2026-05-02T12:00:00.000Z",
          createdAt: "2026-05-02T12:00:00.000Z",
          uploaderName: "Field User",
          imageUrl: "https://example.test/photo-2.jpg",
          tags: [],
        },
      ],
    });
    pdfMocks.renderFieldPhotoReportPdf.mockResolvedValue(Buffer.from("%PDF-1.7 mock"));
    r2Mocks.generateDownloadUrl.mockResolvedValue("https://example.test/report.pdf");
    filesMocks.getFileDownloadUrl.mockResolvedValue({ url: "https://example.test/report.pdf", filename: "roof-report.pdf" });
  });

  it("builds preview sections grouped by tag", async () => {
    const db = createDb();
    const result = await previewFieldPhotoReport(db, access, {
      projectId: "deal-1",
      photoIds: ["photo-1", "photo-2"],
      groupBy: "tag",
      creatorName: "Field User",
    });

    expect(result.cover.reportTitle).toBe("Roof Repair Photo Report");
    expect(result.sections.map((section) => section.title)).toEqual(["Tag: roofing", "Untagged"]);
    expect(projectMocks.assertActiveFieldProject).toHaveBeenCalledWith(db, access, "deal-1");
  });

  it("stores generated reports as tagged file artifacts", async () => {
    const db = createDb();
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              id: "photo-1",
              displayName: "North slope",
              description: "North slope detail",
              takenAt: new Date("2026-05-01T12:00:00.000Z"),
              createdAt: new Date("2026-05-01T12:00:00.000Z"),
              uploaderName: "Field User",
              tags: ["roofing", "urgent"],
              r2Key: "photos/one.jpg",
              externalUrl: "https://example.test/photo-1.jpg",
              externalThumbnailUrl: null,
            },
          ]),
        })),
      })),
    });
    db.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{
          id: "report-1",
          createdAt: new Date("2026-05-03T12:00:00.000Z"),
        }]),
      })),
    });

    const result = await generateFieldPhotoReport(db, access, {
      officeSlug: "trock",
      projectId: "deal-1",
      reportTitle: "Roof Repair Photo Report",
      coverData: {
        creatorName: "Field User",
        companyName: "TRock Construction",
        reportDateLabel: "May 3, 2026",
        projectName: "Roof Repair",
      },
      sections: [
        {
          title: "Section 1",
          photoIds: ["photo-1"],
          photoOverrides: [{ id: "photo-1", description: "Override caption" }],
        },
      ],
    });

    expect(pdfMocks.renderFieldPhotoReportPdf).toHaveBeenCalled();
    expect(r2Mocks.putObject).toHaveBeenCalledWith(expect.stringContaining("photo-reports"), expect.any(Buffer), "application/pdf");
    expect(db.insert).toHaveBeenCalled();
    const insertValues = db.insert.mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(insertValues.category).toBe("other");
    expect(insertValues.tags).toEqual(expect.arrayContaining(["photo-report"]));
    expect(insertValues.tags.some((tag: string) => tag.startsWith("photo-report-exp:"))).toBe(true);
    expect(result.report.id).toBe("report-1");
    expect(result.report.pdfUrl).toBe("https://example.test/report.pdf");
    expect(result.report.expiresAt).toEqual(expect.any(String));
  });

  it("deletes the uploaded object if persisting the report record fails", async () => {
    const db = createDb();
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              id: "photo-1",
              displayName: "North slope",
              description: "North slope detail",
              takenAt: new Date("2026-05-01T12:00:00.000Z"),
              createdAt: new Date("2026-05-01T12:00:00.000Z"),
              uploaderName: "Field User",
              tags: ["roofing", "urgent"],
              r2Key: "photos/one.jpg",
              externalUrl: null,
              externalThumbnailUrl: null,
            },
          ]),
        })),
      })),
    });
    db.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(async () => {
          throw new Error("insert failed");
        }),
      })),
    });

    await expect(generateFieldPhotoReport(db, access, {
      officeSlug: "trock",
      projectId: "deal-1",
      reportTitle: "Roof Repair Photo Report",
      coverData: { creatorName: "Field User" },
      sections: [{ title: "Section 1", photoIds: ["photo-1"] }],
    })).rejects.toThrow("insert failed");

    expect(r2Mocks.deleteObject).toHaveBeenCalledWith(expect.stringContaining("photo-reports"));
  });

  it("lists project reports from tagged file artifacts", async () => {
    const db = createDb();
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => [
            {
              id: "report-1",
              displayName: "Roof Repair Photo Report",
              description: "Generated photo report",
              createdAt: new Date("2026-05-03T12:00:00.000Z"),
              updatedAt: new Date("2026-05-03T12:00:00.000Z"),
              tags: ["photo-report", "photo-report-exp:2026-05-10T12:00:00.000Z"],
            },
            {
              id: "report-2",
              displayName: "Expired Report",
              description: "Should be hidden",
              createdAt: new Date("2026-05-01T12:00:00.000Z"),
              updatedAt: new Date("2026-05-01T12:00:00.000Z"),
              tags: ["photo-report", "photo-report-exp:2026-05-02T12:00:00.000Z"],
            },
          ]),
        })),
      })),
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
    const result = await listFieldProjectReports(db, access, "deal-1");
    expect(result.reports[0]?.title).toBe("Roof Repair Photo Report");
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.expiresAt).toBe("2026-05-10T12:00:00.000Z");
  });

  it("verifies project access before returning a report download", async () => {
    const db = createDb();
    filesMocks.getFileById.mockResolvedValue({
      id: "report-1",
      category: "other",
      tags: ["photo-report", "photo-report-exp:2026-05-20T12:00:00.000Z"],
      dealId: "deal-1",
    });

    const result = await getFieldProjectReportDownload(db, access, "report-1");
    expect(projectMocks.assertActiveFieldProject).toHaveBeenCalledWith(db, access, "deal-1");
    expect(filesMocks.getFileDownloadUrl).toHaveBeenCalledWith(db, "report-1");
    expect(result.url).toBe("https://example.test/report.pdf");
  });

  it("rejects expired report downloads", async () => {
    const db = createDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00.000Z"));
    filesMocks.getFileById.mockResolvedValue({
      id: "report-1",
      category: "other",
      tags: ["photo-report", "photo-report-exp:2026-05-10T12:00:00.000Z"],
      dealId: "deal-1",
    });

    await expect(getFieldProjectReportDownload(db, access, "report-1")).rejects.toMatchObject({ statusCode: 410 });
  });
});
