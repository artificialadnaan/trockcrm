import { beforeEach, describe, expect, it, vi } from "vitest";

const fileServiceMocks = vi.hoisted(() => ({
  buildFileDownloadUrlFromRecord: vi.fn(),
  getDealPhotoTimeline: vi.fn(),
  getFileDownloadUrl: vi.fn(),
}));
const dealServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", () => fileServiceMocks);
vi.mock("../../../src/modules/deals/service.js", () => dealServiceMocks);

const {
  listFieldProjects,
  listFieldProjectPhotos,
  listStarredFieldProjects,
  listNearbyFieldCaptureTargets,
  getFieldProject,
  starFieldProject,
  unstarFieldProject,
} = await import("../../../src/modules/field/projects-service.js");

function tenantDb(rows: unknown[][]) {
  return {
    execute: vi.fn(async () => ({ rows: rows.shift() ?? [] })),
  } as any;
}

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  return "";
}

describe("field projects service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileServiceMocks.buildFileDownloadUrlFromRecord.mockResolvedValue({ url: "https://signed.example/photo.jpg" });
    fileServiceMocks.getFileDownloadUrl.mockResolvedValue({ url: "https://signed.example/photo.jpg" });
    dealServiceMocks.getDealById.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "field-1",
      isActive: true,
    });
  });

  it("lists active projects with a field-safe response shape", async () => {
    const db = tenantDb([
      [{ total: 1 }],
      [{
        id: "deal-1",
        name: "Roof Repair",
        deal_number: "TR-100",
        property_name: "Roof Repair",
        property_address: "123 Main St, Tulsa, OK, 74101",
        stage_name: "Contract",
        last_activity_at: new Date("2026-05-05T12:00:00.000Z"),
        photo_count: 12,
        starred: true,
        awarded_amount: "999999.00",
        source: "internal",
      }],
    ]);

    const result = await listFieldProjects(db, { userId: "field-1", userRole: "field_contractor" }, { search: "roof", page: 2, perPage: 10 });

    expect(result).toEqual({
      projects: [{
        id: "deal-1",
        name: "Roof Repair",
        dealNumber: "TR-100",
        // No project_number on the row and a non-HubSpot deal_number → the display number falls back to it.
        projectNumber: "TR-100",
        propertyName: "Roof Repair",
        propertyAddress: "123 Main St, Tulsa, OK, 74101",
        stage: "Contract",
        lastActivityAt: "2026-05-05T12:00:00.000Z",
        photoCount: 12,
        starred: true,
      }],
      total: 1,
      page: 2,
      perPage: 10,
    });
    expect(JSON.stringify(result)).not.toContain("awarded");
    expect(JSON.stringify(result)).not.toContain("source");
  });

  it("orders the active-projects list PHOTOS-FIRST, then recency, with a stable d.id tiebreak", async () => {
    const db = tenantDb([[{ total: 0 }], []]);
    await listFieldProjects(db, { userId: "field-1", userRole: "field_contractor" });
    const rowsSql = extractSqlText(db.execute.mock.calls[1][0]);
    const orderBy = rowsSql.slice(rowsSql.indexOf("ORDER BY"));
    // The photos-first key (photo_count > 0) DESC must be present and precede the recency COALESCE.
    expect(orderBy).toMatch(/photo_count[\s\S]*>\s*0\)\s*DESC/);
    const photoIdx = orderBy.indexOf("photo_count");
    const recencyIdx = orderBy.indexOf("last_activity_at");
    expect(photoIdx).toBeGreaterThanOrEqual(0);
    expect(photoIdx).toBeLessThan(recencyIdx);
    // A final deterministic d.id tiebreak keeps the per-office SQL order identical to mergeFieldProjects
    // under exact ties (else the fetch-top-N-then-merge-then-slice scheme could drop/shift rows across
    // pages). Mirrors the nearby query's id tiebreak.
    expect(orderBy).toMatch(/d\.id\s+ASC/);
    expect(orderBy.lastIndexOf("d.id")).toBeGreaterThan(recencyIdx);
    // Sort the recency key at the SAME millisecond precision the JS merge sees (mapFieldProject converts
    // timestamps via Date -> ISO, which is ms). Without this, two rows differing only below ms order by
    // full timestamptz in SQL but tie in JS (falling to id), so the per-office order and mergeFieldProjects
    // could disagree at the fetch boundary and skip/shift rows across pages.
    expect(orderBy).toMatch(/date_trunc\('milliseconds'/);
  });

  it("fetches a single active project by id with real photoCount and starred (not the list window)", async () => {
    const db = tenantDb([
      [{
        id: "deal-9",
        name: "Zero Photo Job",
        deal_number: "TR-9",
        property_name: "Zero Photo Job",
        property_address: null,
        stage_name: "Estimating",
        last_activity_at: "2026-06-15T00:00:00.000Z",
        photo_count: 0,
        starred: true,
      }],
    ]);
    const result = await getFieldProject(db, { userId: "field-1", userRole: "field_contractor" }, "deal-9");
    expect(result).toMatchObject({ id: "deal-9", photoCount: 0, starred: true, stage: "Estimating" });
    const sqlText = extractSqlText(db.execute.mock.calls[0][0]);
    expect(sqlText).toContain("d.id ="); // by-id, not a list scan
    expect(sqlText).toContain("photo_stats"); // real photo count
    expect(sqlText).toContain("field_user_starred_projects"); // real starred state
  });

  it("throws 404 when the id is not an active field project", async () => {
    const db = tenantDb([[]]);
    await expect(
      getFieldProject(db, { userId: "field-1", userRole: "field_contractor" }, "missing"),
    ).rejects.toThrow(/not found/i);
  });

  it("lists starred projects sorted by recent project photo activity", async () => {
    const db = tenantDb([
      [{
        id: "deal-1",
        name: "Starred Roof",
        deal_number: "TR-101",
        property_name: "Starred Roof",
        property_address: "456 Main St",
        stage_name: "Estimating",
        last_activity_at: "2026-05-05T12:00:00.000Z",
        photo_count: 3,
        starred: true,
      }],
    ]);

    const result = await listStarredFieldProjects(db, { userId: "field-1", userRole: "field_contractor" });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({ id: "deal-1", starred: true, photoCount: 3 });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("stars and unstars projects idempotently", async () => {
    const starDb = tenantDb([
      [{
        id: "deal-1",
        name: "Active",
        deal_number: "TR-1",
        stage_name: "Contract",
        last_activity_at: null,
      }],
      [],
    ]);
    await expect(starFieldProject(starDb, { userId: "field-1", userRole: "field_contractor" }, "deal-1")).resolves.toEqual({ starred: true });
    expect(starDb.execute).toHaveBeenCalledTimes(2);

    const unstarDb = tenantDb([[]]);
    await expect(unstarFieldProject(unstarDb, { userId: "field-1", userRole: "field_contractor" }, "deal-1")).resolves.toEqual({ starred: false });
    expect(unstarDb.execute).toHaveBeenCalledTimes(1);
  });

  it("returns field-safe photo records for active projects", async () => {
    const db = tenantDb([
      [{
        id: "deal-1",
        name: "Active",
        deal_number: "TR-1",
        stage_name: "Contract",
        last_activity_at: null,
      }],
    ]);
    fileServiceMocks.getDealPhotoTimeline.mockResolvedValue({
      photos: [{
        id: "photo-1",
        category: "photo",
        photoCategory: "damage",
        subcategory: null,
        displayName: "Damage",
        mimeType: "image/jpeg",
        fileSizeBytes: 1000,
        fileExtension: ".jpg",
        r2Key: "internal/r2/key",
        r2Bucket: "bucket",
        dealId: "deal-1",
        description: "North slope",
        takenAt: null,
        createdAt: new Date("2026-05-05T12:00:00.000Z"),
        uploadedBy: "field-1",
        uploaderName: "Field User",
        uploaderAvatarUrl: null,
        latitude: "35.1234567",
        longitude: "-97.1234567",
        address: "123 Main St",
        addressSource: "exif",
        geocodedAt: null,
        procoreSyncStatus: null,
        deletedAt: null,
        externalThumbnailUrl: null,
        externalUrl: null,
        // getDealPhotoTimeline now resolves the display URLs in-batch; listFieldProjectPhotos just maps them.
        thumbnailUrl: "https://signed.example/thumb.jpg",
        fullUrl: "https://signed.example/full.jpg",
      }],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
    });

    const result = await listFieldProjectPhotos(db, { userId: "field-1", userRole: "field_contractor" }, "deal-1", { categories: ["damage"] });

    // Default field window: page 1, perPage 200 (the surface's prior single-load cap; no regression).
    expect(fileServiceMocks.getDealPhotoTimeline).toHaveBeenCalledWith(db, "deal-1", 1, 200, {
      categories: ["damage"],
    });
    expect(result.photos[0]).toEqual(expect.objectContaining({
      id: "photo-1",
      imageUrl: "https://signed.example/thumb.jpg", // thumbnail for the grid
      fullImageUrl: "https://signed.example/full.jpg", // high-res for the viewer
      category: "photo",
      photoCategory: "damage",
      address: "123 Main St",
    }));
    // URL resolution moved into getDealPhotoTimeline (batched), so listFieldProjectPhotos no longer presigns per photo.
    expect(fileServiceMocks.buildFileDownloadUrlFromRecord).not.toHaveBeenCalled();
    expect(fileServiceMocks.getFileDownloadUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(result.photos[0])).not.toContain("r2Key");
    expect(JSON.stringify(result.photos[0])).not.toContain("r2Bucket");
  });

  it("is UNSCOPED for reps on the field surface — no assigned_rep_id filter (every field user sees every project)", async () => {
    const db = tenantDb([
      [{ total: 0 }],
      [],
    ]);

    await expect(listFieldProjects(db, { userId: "rep-1", userRole: "rep" }, { search: "roof" })).resolves.toEqual({
      projects: [],
      total: 0,
      page: 1,
      perPage: 50,
    });

    // A "rep" must NOT have their list narrowed to assigned deals — the field surface is office- and
    // rep-agnostic (matches field_contractor/construction). Neither the count nor the rows query may
    // carry the old assigned_rep_id restriction.
    const allSql = db.execute.mock.calls.map((c: any[]) => extractSqlText(c[0])).join(" | ");
    expect(allSql).not.toContain("assigned_rep_id");
  });

  it("does not rep-scope the starred list either", async () => {
    const db = tenantDb([[]]);
    await listStarredFieldProjects(db, { userId: "rep-1", userRole: "rep" });
    const allSql = db.execute.mock.calls.map((c: any[]) => extractSqlText(c[0])).join(" | ");
    expect(allSql).not.toContain("assigned_rep_id");
  });

  it("preserves deal identifiers for duplicate-name field projects", async () => {
    const db = tenantDb([
      [{ total: 2 }],
      [
        {
          id: "deal-1",
          name: "Steeplechase",
          deal_number: "HS-320839598785",
          property_name: "Steeplechase",
          property_address: "Knoxville, TN",
          stage_name: "Estimate Sent to Client",
          last_activity_at: new Date("2026-05-05T12:00:00.000Z"),
          photo_count: 54,
          starred: false,
        },
        {
          id: "deal-2",
          name: "Steeplechase",
          deal_number: "HS-324283495135",
          property_name: "Steeplechase",
          property_address: null,
          stage_name: "Due Diligence",
          last_activity_at: new Date("2026-05-04T12:00:00.000Z"),
          photo_count: 0,
          starred: false,
        },
      ],
    ]);

    const result = await listFieldProjects(db, { userId: "field-1", userRole: "field_contractor" });

    expect(result.projects.map((project) => ({ name: project.name, dealNumber: project.dealNumber }))).toEqual([
      { name: "Steeplechase", dealNumber: "HS-320839598785" },
      { name: "Steeplechase", dealNumber: "HS-324283495135" },
    ]);
  });

  it("lists nearby deal/project capture targets by device coordinates without surfacing opportunities", async () => {
    const db = tenantDb([
      [
        {
          id: "deal-1",
          name: "121 Preston Oaks",
          deal_number: "HS-320839598785",
          project_number: "DFW-1-17426-aa",
          stage_name: "Construction",
          company_name: "Preston Oaks HOA",
          last_updated_at: new Date("2026-06-20T12:00:00.000Z"),
          distance_miles: "0.42",
        },
      ],
    ]);

    const result = await listNearbyFieldCaptureTargets(db, { userId: "field-1", userRole: "field_contractor" }, {
      latitude: 32.911,
      longitude: -96.775,
      limit: 3,
    });

    expect(result).toEqual({
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
    const sqlText = extractSqlText(db.execute.mock.calls[0][0]);
    expect(sqlText).toContain("property_lat");
    expect(sqlText).toContain("property_lng");
    expect(sqlText).toContain("pipeline_disposition IS DISTINCT FROM 'opportunity'");
    expect(sqlText).toContain("ORDER BY distance_miles ASC");
  });
});
