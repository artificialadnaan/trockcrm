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
  // The download path builds the URL from the record the access gate already read, rather than fetching the
  // file a second time. Mirrored here because this mock REPLACES the module: a missing export is undefined
  // at the call site, not a helpful error.
  buildFileDownloadUrlFromRecord: vi.fn(async () => ({ url: "https://r2.test/report.pdf", filename: "report.pdf" })),
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
  prepareFieldPhotoReport,
  renderAndStoreFieldPhotoReportPdf,
} = await import("../../../src/modules/field/photo-reports-service.js");

const access = { userId: "user-1", userRole: "admin" } as const;

function createDb() {
  return {
    select: vi.fn(),
    insert: vi.fn(),
  } as any;
}

function mockRenderPhotoQueries(
  db: ReturnType<typeof createDb>,
  rows: Array<Record<string, unknown>>,
  sourceLeadId: string | null = null,
) {
  const scopeWhere = vi.fn(() => ({
    limit: vi.fn(async () => [{ sourceLeadId }]),
  }));
  const renderWhere = vi.fn(async () => rows);

  db.select
    .mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: scopeWhere,
      })),
    }))
    .mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: renderWhere,
        })),
      })),
    }));

  return { scopeWhere, renderWhere };
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

  it("carries the render deadline through to the PDF upload", async () => {
    // Bounding the reads and transcodes but not the PUT just moves the stall one line down: an
    // accepted-then-stalled upload leaves renderAndStoreFieldPhotoReportPdf pending forever, and the
    // AI-report poller is single-in-flight, so every later report queues behind a handler nothing can free.
    // Built from a literal rather than prepareFieldPhotoReport: this asserts the SIGNAL contract, and going
    // through the full prepare path would only add database fixtures that have nothing to do with it.
    const controller = new AbortController();
    const prepared = {
      project: { dealNumber: "D-1" },
      title: "Report",
      cover: { reportTitle: "Report", creatorName: "Sam", companyName: "TRock", reportDateLabel: "May 3, 2026", projectName: "Roof Repair", photoCount: 1 },
      renderSections: [{ title: "Section 1", photos: [] }],
      executiveSummary: null,
      photoLayout: "grid",
      now: new Date("2026-05-03T12:00:00.000Z"),
    };

    await renderAndStoreFieldPhotoReportPdf(prepared as never, "dallas", controller.signal);

    // Both halves of the render carry it — the layout's object reads/transcodes AND the upload that follows.
    expect(pdfMocks.renderFieldPhotoReportPdf).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(r2Mocks.putObject).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      "application/pdf",
      { signal: controller.signal },
    );
  });

  it("stores generated reports as tagged file artifacts", async () => {
    const db = createDb();
    mockRenderPhotoQueries(db, [
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
    ]);
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
    // The human path passes no signal, so the upload is unbounded exactly as it has always been — the
    // fourth argument exists for the AI report, whose poller is single-in-flight and cannot afford a
    // stalled PUT.
    expect(r2Mocks.putObject).toHaveBeenCalledWith(
      expect.stringContaining("photo-reports"),
      expect.any(Buffer),
      "application/pdf",
      { signal: undefined },
    );
    expect(db.insert).toHaveBeenCalled();
    const insertValues = db.insert.mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(insertValues.category).toBe("other");
    expect(insertValues.tags).toEqual(expect.arrayContaining(["photo-report"]));
    expect(insertValues.tags.some((tag: string) => tag.startsWith("photo-report-exp:"))).toBe(true);
    expect(pdfMocks.renderFieldPhotoReportPdf).toHaveBeenCalledWith(expect.objectContaining({
      sections: [
        expect.objectContaining({
          photos: [
            expect.objectContaining({ id: "photo-1" }),
          ],
        }),
      ],
    }));
    expect(result.report.id).toBe("report-1");
    expect(result.report.pdfUrl).toBe("https://example.test/report.pdf");
    // Reports stay available for 90 days after generation (expiresAt = now + 90d).
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const retentionMs = new Date(result.report.expiresAt).getTime() - Date.now();
    expect(retentionMs).toBeGreaterThan(NINETY_DAYS_MS - 60_000); // ~90 days, allow a minute of execution skew
    expect(retentionMs).toBeLessThanOrEqual(NINETY_DAYS_MS);
  });

  it("renders selected lead-origin photos in the final report output", async () => {
    const db = createDb();
    mockRenderPhotoQueries(db, [
      {
        id: "photo-lead-1",
        displayName: "Lead photo",
        description: "Captured before conversion",
        takenAt: new Date("2026-05-04T12:00:00.000Z"),
        createdAt: new Date("2026-05-04T12:00:00.000Z"),
        uploaderName: "Field User",
        tags: ["inspection"],
        r2Key: "photos/lead-photo.jpg",
        externalUrl: null,
        externalThumbnailUrl: null,
      },
    ], "lead-1");
    db.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{
          id: "report-2",
          createdAt: new Date("2026-05-05T12:00:00.000Z"),
        }]),
      })),
    });

    await generateFieldPhotoReport(db, access, {
      officeSlug: "trock",
      projectId: "deal-1",
      reportTitle: "Roof Repair Photo Report",
      coverData: { creatorName: "Field User" },
      sections: [{ title: "Lead Photos", photoIds: ["photo-lead-1"] }],
    });

    expect(pdfMocks.renderFieldPhotoReportPdf).toHaveBeenCalledWith(expect.objectContaining({
      sections: [
        expect.objectContaining({
          title: "Lead Photos",
          photos: [
            expect.objectContaining({ id: "photo-lead-1" }),
          ],
        }),
      ],
    }));
  });

  it("keeps the render photo set aligned with the project timeline selection", async () => {
    const db = createDb();
    mockRenderPhotoQueries(db, [
      {
        id: "photo-1",
        displayName: "North slope",
        description: "North slope detail",
        takenAt: new Date("2026-05-01T12:00:00.000Z"),
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
        uploaderName: "Field User",
        tags: ["roofing"],
        r2Key: "photos/one.jpg",
        externalUrl: null,
        externalThumbnailUrl: null,
      },
    ]);

    const result = generateFieldPhotoReport(db, access, {
      officeSlug: "trock",
      projectId: "deal-1",
      reportTitle: "Roof Repair Photo Report",
      coverData: { creatorName: "Field User" },
      sections: [{ title: "Section 1", photoIds: ["photo-1", "photo-2"] }],
    });

    await expect(result).rejects.toHaveProperty("statusCode", 400);
    await expect(result).rejects.toThrow("One or more selected photos are unavailable for report generation.");

    expect(pdfMocks.renderFieldPhotoReportPdf).not.toHaveBeenCalled();
  });

  it("resolves a selected photo that lives on a later timeline page", async () => {
    const db = createDb();
    // Two pages of photos; the selected photo-201 is only on page 2. The old first-page-only validation
    // would 400 it as unavailable — now we page through until every selected id is found.
    projectMocks.listFieldProjectPhotos.mockImplementation(
      async (_db: unknown, _access: unknown, _dealId: string, _filters: unknown, input?: { page?: number }) => {
        if (input?.page === 2) {
          return {
            photos: [
              {
                id: "photo-201",
                displayName: "Late page photo",
                description: null,
                takenAt: "2026-05-03T12:00:00.000Z",
                createdAt: "2026-05-03T12:00:00.000Z",
                uploaderName: "Field User",
                imageUrl: "https://example.test/photo-201.jpg",
                tags: [],
              },
            ],
            pagination: { page: 2, limit: 200, total: 201, totalPages: 2 },
          };
        }
        return {
          photos: [{ id: "photo-1", displayName: "First page", description: null, takenAt: null, createdAt: "2026-05-01T12:00:00.000Z", uploaderName: "Field User", imageUrl: "https://example.test/photo-1.jpg", tags: [] }],
          pagination: { page: 1, limit: 200, total: 201, totalPages: 2 },
        };
      },
    );

    const result = await previewFieldPhotoReport(db, access, {
      projectId: "deal-1",
      photoIds: ["photo-201"],
      groupBy: "none",
      creatorName: "Field User",
    });

    expect(result.cover.photoCount).toBe(1);
    // Paged to page 2 to find the late selection.
    expect(projectMocks.listFieldProjectPhotos).toHaveBeenCalledWith(db, access, "deal-1", { includeDeleted: false }, { page: 2, perPage: 200 });
  });

  it("deletes the uploaded object if persisting the report record fails", async () => {
    const db = createDb();
    mockRenderPhotoQueries(db, [
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
    ]);
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
    const file = {
      id: "report-1",
      category: "other",
      tags: ["photo-report", "photo-report-exp:2099-05-20T12:00:00.000Z"],
      dealId: "deal-1",
      r2Key: "office_dallas/report.pdf",
      displayName: "Roof Repair Photo Report",
      fileExtension: ".pdf",
    };
    filesMocks.getFileById.mockResolvedValue(file);
    filesMocks.buildFileDownloadUrlFromRecord.mockResolvedValue({
      url: "https://example.test/report.pdf",
      filename: "Roof Repair Photo Report.pdf",
    } as never);

    const result = await getFieldProjectReportDownload(db, access, "report-1");
    expect(projectMocks.assertActiveFieldProject).toHaveBeenCalledWith(db, access, "deal-1");
    // Built from the record the gate already read — the file is fetched ONCE, not once to authorise and
    // again to presign.
    expect(filesMocks.buildFileDownloadUrlFromRecord).toHaveBeenCalledWith(file);
    expect(filesMocks.getFileById).toHaveBeenCalledTimes(1);
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
