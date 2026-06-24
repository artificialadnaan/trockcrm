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
      pagination: { page: 1, limit: 60, total: 1, totalPages: 1 },
    });

    const result = await listFieldProjectPhotos(db, { userId: "field-1", userRole: "field_contractor" }, "deal-1", { categories: ["damage"] });

    // Default numbered-pages window: page 1, perPage 60.
    expect(fileServiceMocks.getDealPhotoTimeline).toHaveBeenCalledWith(db, "deal-1", 1, 60, {
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
});
