import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = {
      id: "admin-1",
      email: "admin@example.com",
      firstName: "Admin",
      lastName: "User",
      role: "admin",
      tenantId: "office-1",
      active: true,
    };
    req.user = { id: "admin-1", role: "admin", activeOfficeId: "office-1" };
    next();
  },
}));
vi.mock("../../../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.tenantDb = { execute: vi.fn() };
    req.commitTransaction = vi.fn(async () => undefined);
    next();
  },
}));

// Cross-office reads run via the field-only fan-out. Mock it as a single-office pass-through (one
// fake office) so these tests still assert the read endpoints route through the field-safe services;
// the fan-out/merge/degrade behavior itself is covered by cross-office.test.ts + field-cross-office-routes.test.ts.
vi.mock("../../../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/field/cross-office.js")>();
  const office = { id: "office-1", slug: "trock" };
  const officeDb = { execute: vi.fn() } as any;
  return {
    ...actual,
    fanOutActiveOffices: vi.fn(async (run: any) => ({ results: [{ office, value: await run(officeDb, office) }], failures: [] })),
    withResolvedOffice: vi.fn(async (_kind: any, _id: any, run: any) => ({ value: await run(officeDb, office), office })),
    // Cross-office WRITE helpers: resolve to the single fake office and pass the fake db through, so the
    // write endpoints still assert they route through the field-safe services (resolution/transaction
    // behavior itself is covered by cross-office.test.ts + cross-office-writes.test.ts). Pool-free.
    getFieldOfficeById: vi.fn(async () => office),
    resolveWriteOffice: vi.fn(async () => office),
    resolveFieldWriteOffice: vi.fn(async () => office),
    runInOffice: vi.fn(async (_office: any, run: any) => run(officeDb, office)),
    runInOfficeTransaction: vi.fn(async (_office: any, _userId: any, run: any) => run(officeDb, office)),
  };
});

const projectMocks = vi.hoisted(() => ({
  FIELD_PROJECTS_MAX_FETCH: 500,
  listFieldProjects: vi.fn(),
  getFieldProject: vi.fn(),
  listFieldProjectPhotos: vi.fn(),
  listStarredFieldProjects: vi.fn(),
  listNearbyFieldCaptureTargets: vi.fn(),
  searchFieldCaptureTargets: vi.fn(),
  mergeFieldCaptureTargets: vi.fn(() => []),
  mergeFieldProjects: vi.fn(
    (perOffice: Array<{ office: { id: string; slug: string }; projects: Array<Record<string, unknown>> }>) =>
      perOffice.flatMap(({ office, projects }) =>
        projects.map((project) => ({ ...project, officeId: office.id, officeSlug: office.slug })),
      ),
  ),
  assertAccessibleFieldCaptureTarget: vi.fn(),
  starFieldProject: vi.fn(),
  unstarFieldProject: vi.fn(),
}));

const photoMocks = vi.hoisted(() => ({
  requestFieldPhotoUploadUrl: vi.fn(),
  confirmFieldPhotoUpload: vi.fn(),
  listPendingFieldPhotos: vi.fn(),
  assignPendingFieldPhotoTarget: vi.fn(),
  // Format validators the cross-office write routes call before resolving the office (no-op in tests).
  assertValidCaptureTargetIds: vi.fn(),
  assertValidUuid: vi.fn(),
}));

const transcriptionMocks = vi.hoisted(() => ({
  getFieldPhotoTranscriptionConfig: vi.fn(),
  transcribePhotoDescriptionAudio: vi.fn(),
  transcribeAndPersistFieldPhotoDescription: vi.fn(),
}));

const tagMocks = vi.hoisted(() => ({
  replaceFieldPhotoTags: vi.fn(),
  deleteFieldPhotoTag: vi.fn(),
  searchFieldProjectTags: vi.fn(),
}));

const reportMocks = vi.hoisted(() => ({
  previewFieldPhotoReport: vi.fn(),
  generateFieldPhotoReport: vi.fn(),
  listFieldProjectReports: vi.fn(),
  getFieldProjectReportDownload: vi.fn(),
}));

vi.mock("../../../src/modules/field/projects-service.js", () => projectMocks);
vi.mock("../../../src/modules/field/photos-service.js", () => photoMocks);
vi.mock("../../../src/modules/field/photo-transcription-service.js", () => transcriptionMocks);
vi.mock("../../../src/modules/field/photo-tags-service.js", () => tagMocks);
vi.mock("../../../src/modules/field/photo-reports-service.js", () => reportMocks);

const { fieldRoutes } = await import("../../../src/modules/field/routes.js");

function findRoute(router: any, method: string, path: string) {
  const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

describe("field routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectMocks.listFieldProjects.mockResolvedValue({ projects: [], total: 0, page: 1, perPage: 50 });
    projectMocks.getFieldProject.mockResolvedValue({ id: "deal-1", name: "Roof", photoCount: 0, starred: false });
    projectMocks.listStarredFieldProjects.mockResolvedValue({ projects: [] });
    projectMocks.listNearbyFieldCaptureTargets.mockResolvedValue({ targets: [] });
    projectMocks.searchFieldCaptureTargets.mockResolvedValue({ targets: [] });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValue({ id: "lead-1", type: "lead" });
    projectMocks.starFieldProject.mockResolvedValue({ starred: true });
    projectMocks.unstarFieldProject.mockResolvedValue({ starred: false });
    projectMocks.listFieldProjectPhotos.mockResolvedValue({ photos: [], pagination: { page: 1, limit: 200, total: 0, totalPages: 0 } });
    photoMocks.requestFieldPhotoUploadUrl.mockResolvedValue({ uploadUrl: "https://r2.example/upload", objectKey: "key", uploadToken: "token" });
    photoMocks.confirmFieldPhotoUpload.mockResolvedValue({ photo: { id: "photo-1", category: "photo" } });
    photoMocks.listPendingFieldPhotos.mockResolvedValue({ photos: [{ id: "pending-1" }] });
    photoMocks.assignPendingFieldPhotoTarget.mockResolvedValue({ photo: { id: "pending-1", dealId: "deal-1" } });
    transcriptionMocks.getFieldPhotoTranscriptionConfig.mockReturnValue({ configured: false });
    transcriptionMocks.transcribePhotoDescriptionAudio.mockResolvedValue({ transcript: "North slope detail", language: "en" });
    transcriptionMocks.transcribeAndPersistFieldPhotoDescription.mockResolvedValue({ transcript: "North slope detail", language: "en" });
    tagMocks.replaceFieldPhotoTags.mockResolvedValue({ tags: ["roofing", "urgent"] });
    tagMocks.deleteFieldPhotoTag.mockResolvedValue({ tags: ["urgent"] });
    tagMocks.searchFieldProjectTags.mockResolvedValue({ tags: ["roofing", "urgent"] });
    reportMocks.previewFieldPhotoReport.mockResolvedValue({ cover: { reportTitle: "Roof Repair Photo Report" }, sections: [] });
    reportMocks.generateFieldPhotoReport.mockResolvedValue({ report: { id: "report-1", title: "Roof Repair Photo Report" } });
    reportMocks.listFieldProjectReports.mockResolvedValue({ reports: [{ id: "report-1", title: "Roof Repair Photo Report" }] });
    reportMocks.getFieldProjectReportDownload.mockResolvedValue({ url: "https://r2.example/report.pdf", filename: "roof-report.pdf" });
  });

  it("returns the authenticated field contractor profile", async () => {
    const res = await invokeRoute("get", "/me", {});

    expect(res.body).toEqual({
      user: {
        id: "admin-1",
        email: "admin@example.com",
        firstName: "Admin",
        lastName: "User",
        role: "admin",
        tenantId: "office-1",
        active: true,
      },
    });
  });

  it("routes field project list, starred list, star toggles, and photos through field-safe services", async () => {
    await invokeRoute("get", "/projects", { query: { search: "roof", page: "2", perPage: "25" } });
    // Cross-office: each office is fetched from page 1 with enough rows to cover the requested window
    // (page*perPage, capped at 100); the page/perPage slice is applied AFTER the cross-office merge.
    expect(projectMocks.listFieldProjects).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), {
      search: "roof",
      status: undefined,
      page: 1,
      perPage: 50,
    });
    // The cross-office order is produced by mergeFieldProjects (photos-first), not an inline route sort,
    // and the route must forward each office's context so the merged rows can be office-stamped.
    expect(projectMocks.mergeFieldProjects).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          office: expect.objectContaining({ id: expect.any(String), slug: expect.any(String) }),
          projects: expect.any(Array),
        }),
      ]),
    );

    await invokeRoute("get", "/projects/starred", {});
    expect(projectMocks.listStarredFieldProjects).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }));

    // By-id metadata path (so the detail page never depends on the list window / photos-first ordering).
    const byId = await invokeRoute("get", "/projects/:dealId", { params: { dealId: "deal-1" } });
    // dealId format is validated BEFORE office resolution (a non-uuid must be a clean 400, not a swallowed
    // ::uuid cast surfacing as a 503).
    expect(photoMocks.assertValidUuid).toHaveBeenCalledWith("deal-1", "dealId");
    expect(projectMocks.getFieldProject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), "deal-1");
    expect(byId.body.project).toMatchObject({ id: "deal-1", officeId: "office-1", officeSlug: "trock" });

    await invokeRoute("post", "/projects/:dealId/star", { params: { dealId: "deal-1" } });
    expect(projectMocks.starFieldProject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), "deal-1");

    await invokeRoute("delete", "/projects/:dealId/star", { params: { dealId: "deal-1" } });
    expect(projectMocks.unstarFieldProject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), "deal-1");

    await invokeRoute("get", "/projects/:dealId/photos", {
      params: { dealId: "deal-1" },
      query: { category: "damage,safety", uploader: "u1,u2", from: "2026-05-01", to: "2026-05-05" },
    });
    expect(projectMocks.listFieldProjectPhotos).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), "deal-1", {
      categories: ["damage", "safety"],
      uploaderIds: ["u1", "u2"],
      from: "2026-05-01",
      to: "2026-05-05",
      includeDeleted: false,
    }, { page: 1, perPage: undefined });
  });

  it("fetches enough rows per office to cover deep pages (cross-office pagination beyond the first window)", async () => {
    // page 3 perPage 50 → offset 100; each office must be fetched with >= offset+perPage so the merged
    // slice [100,150] isn't empty. The old min(100, …) cap returned empty/wrong pages past page 2.
    await invokeRoute("get", "/projects", { query: { page: "3", perPage: "50" } });
    expect(projectMocks.listFieldProjects).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ page: 1, perPage: 150 }),
    );
  });

  it("routes field photo upload URL and confirm requests through field-safe services", async () => {
    await invokeRoute("post", "/photos/upload-url", {
      body: { opportunityId: "deal-2", contentType: "image/jpeg", sizeBytes: 1000, category: "damage", caption: "North slope", tags: ["urgent"] },
    });
    expect(photoMocks.requestFieldPhotoUploadUrl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      officeSlug: "trock",
      userId: "admin-1",
      userRole: "admin",
      opportunityId: "deal-2",
      contentType: "image/jpeg",
      sizeBytes: 1000,
      photoCategory: "damage",
      caption: "North slope",
      tags: ["urgent"],
    }));

    await invokeRoute("post", "/photos/confirm-upload", {
      body: {
        opportunityId: "deal-2",
        objectKey: "key",
        uploadToken: "token",
        latitude: 35,
        longitude: -97,
        addressSource: "live_gps",
        takenAt: "2026-05-05T12:00:00.000Z",
      },
      ip: "127.0.0.1",
      headers: { "user-agent": "vitest" },
    });
    expect(photoMocks.confirmFieldPhotoUpload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
      officeId: "office-1",
      opportunityId: "deal-2",
      objectKey: "key",
      uploadToken: "token",
      addressSource: "live_gps",
      auditContext: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    }));
  });

  it("lists pending field photos and assigns them to a selected target", async () => {
    await invokeRoute("get", "/photos/pending", {});
    expect(photoMocks.listPendingFieldPhotos).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    });

    await invokeRoute("post", "/photos/:photoId/assign-target", {
      params: { photoId: "pending-1" },
      body: { dealId: "deal-1" },
    });
    expect(photoMocks.assignPendingFieldPhotoTarget).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, {
      photoId: "pending-1",
      dealId: "deal-1",
      leadId: undefined,
      opportunityId: undefined,
    });
  });

  it("routes field target search through the field-safe search service", async () => {
    projectMocks.searchFieldCaptureTargets.mockResolvedValueOnce({ targets: [] });

    await invokeRoute("get", "/photo-targets/search", { query: { search: "waters", limit: "15" } });

    expect(projectMocks.searchFieldCaptureTargets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), {
      search: "waters",
      limit: 15,
    });
  });

  it("routes nearby field targets through the deal/project-only nearby service with a default limit of 3", async () => {
    projectMocks.listNearbyFieldCaptureTargets.mockResolvedValueOnce({
      targets: [{
        id: "deal-1",
        type: "deal",
        name: "121 Preston Oaks",
        recordNumber: "DFW-1-17426-aa",
        stageName: "Construction",
        companyName: "Preston Oaks HOA",
        lastUpdatedAt: new Date("2026-06-20T12:00:00.000Z"),
        distanceMiles: 0.42,
      }],
    });

    const res = await invokeRoute("get", "/photo-targets/nearby", { query: { lat: "32.911", lng: "-96.775" } });

    expect(projectMocks.listNearbyFieldCaptureTargets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), {
      latitude: 32.911,
      longitude: -96.775,
      limit: 3,
    });
    expect(res.body).toEqual({
      targets: [expect.objectContaining({
        id: "deal-1",
        type: "deal",
        distanceMiles: 0.42,
      })],
    });
  });

  it.each([
    { lat: "abc", lng: "-96.775" },
    { lat: "91", lng: "-96.775" },
    { lat: "32.911", lng: "-181" },
    { lat: "", lng: "-96.775" }, // blank string: Number("")===0 must not pass as a valid coordinate
    { lat: "32.911", lng: "" },
    { lat: "  ", lng: "-96.775" }, // whitespace-only likewise
  ])("rejects invalid nearby coordinate query %# with 400", async (query) => {
    await expect(invokeRoute("get", "/photo-targets/nearby", { query })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(projectMocks.listNearbyFieldCaptureTargets).not.toHaveBeenCalled();
  });

  it.each(["abc", "15abc", "-1", "999"])("rejects invalid field target search limit %s with 400", async (limit) => {
    await expect(invokeRoute("get", "/photo-targets/search", { query: { search: "waters", limit } })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(projectMocks.searchFieldCaptureTargets).not.toHaveBeenCalled();
  });

  it("validates URL-selected capture targets before the field app activates capture", async () => {
    await invokeRoute("get", "/photo-targets/validate", { query: { leadId: "lead-1" } });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
      dealId: undefined,
      leadId: "lead-1",
      opportunityId: undefined,
    });
  });

  it("routes session and persisted photo dictation through the transcription service", async () => {
    const configResponse = await invokeRoute("get", "/photos/transcribe-description", {});
    expect(configResponse.body).toEqual({ configured: false });
    expect(transcriptionMocks.getFieldPhotoTranscriptionConfig).toHaveBeenCalled();

    await invokeRoute("post", "/photos/transcribe-description", {
      body: Buffer.from("audio"),
      headers: { "content-type": "audio/webm", "x-file-name": "clip.webm" },
    });
    expect(transcriptionMocks.transcribePhotoDescriptionAudio).toHaveBeenCalledWith({
      audio: Buffer.from("audio"),
      mimeType: "audio/webm",
      fileName: "clip.webm",
    });

    await invokeRoute("post", "/photos/:photoId/transcribe-description", {
      params: { photoId: "photo-1" },
      body: Buffer.from("audio"),
      headers: { "content-type": "audio/webm", "x-file-name": "clip.webm", "user-agent": "vitest" },
      ip: "127.0.0.1",
    });
    expect(transcriptionMocks.transcribeAndPersistFieldPhotoDescription).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, {
      photoId: "photo-1",
      audio: Buffer.from("audio"),
      mimeType: "audio/webm",
      fileName: "clip.webm",
      auditContext: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    });
  });

  it("routes field photo tag writes and project tag autocomplete through the tag service", async () => {
    await invokeRoute("post", "/photos/:photoId/tags", {
      params: { photoId: "photo-1" },
      body: { tags: ["roofing", "urgent"] },
    });
    expect(tagMocks.replaceFieldPhotoTags).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, {
      photoId: "photo-1",
      tags: ["roofing", "urgent"],
    });

    await invokeRoute("delete", "/photos/:photoId/tags/:tag", {
      params: { photoId: "photo-1", tag: encodeURIComponent("roofing") },
    });
    expect(tagMocks.deleteFieldPhotoTag).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, {
      photoId: "photo-1",
      tag: "roofing",
    });

    await invokeRoute("get", "/projects/:dealId/tags", {
      params: { dealId: "deal-1" },
      query: { q: "ro", limit: "5" },
    });
    expect(tagMocks.searchFieldProjectTags).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, {
      projectId: "deal-1",
      query: "ro",
      limit: 5,
    });
  });

  it("routes field report preview, generation, listing, and download through the report service", async () => {
    await invokeRoute("post", "/reports/preview", {
      body: { projectId: "deal-1", photoIds: ["photo-1", "photo-2"], groupBy: "tag" },
    });
    expect(reportMocks.previewFieldPhotoReport).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, {
      projectId: "deal-1",
      photoIds: ["photo-1", "photo-2"],
      groupBy: "tag",
      creatorName: "Admin User",
    });

    await invokeRoute("post", "/reports/generate", {
      body: {
        projectId: "deal-1",
        reportTitle: "Roof Repair Photo Report",
        coverData: { creatorName: "Admin User", companyName: "TRock Construction" },
        sections: [{ title: "Section 1", photoIds: ["photo-1"], photoOverrides: [{ id: "photo-1", description: "North slope" }] }],
      },
    });
    expect(reportMocks.generateFieldPhotoReport).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, {
      officeSlug: "trock",
      projectId: "deal-1",
      reportTitle: "Roof Repair Photo Report",
      coverData: { creatorName: "Admin User", companyName: "TRock Construction", reportDateLabel: null, projectName: null },
      sections: [{ title: "Section 1", photoIds: ["photo-1"], photoOverrides: [{ id: "photo-1", description: "North slope" }] }],
    });

    await invokeRoute("get", "/projects/:dealId/reports", {
      params: { dealId: "deal-1" },
    });
    expect(reportMocks.listFieldProjectReports).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, "deal-1");

    await invokeRoute("get", "/reports/:reportId/download", {
      params: { reportId: "report-1" },
    });
    expect(reportMocks.getFieldProjectReportDownload).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
    }, "report-1");
  });
});

async function invokeRoute(method: string, path: string, reqPatch: Record<string, unknown>) {
  const handlers = findRoute(fieldRoutes, method, path);
  const req: Record<string, unknown> = { query: {}, params: {}, body: {}, officeSlug: "trock", ip: undefined, headers: {}, ...reqPatch };
  const res: Record<string, unknown> = {
    body: undefined,
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };

  for (const handler of handlers) {
    await handler(req, res, (err?: unknown) => {
      if (err) throw err;
    });
  }
  return res;
}
