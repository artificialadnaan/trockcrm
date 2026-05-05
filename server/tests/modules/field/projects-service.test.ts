import { beforeEach, describe, expect, it, vi } from "vitest";

const fileServiceMocks = vi.hoisted(() => ({
  getDealPhotoTimeline: vi.fn(),
  getFileDownloadUrl: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", () => fileServiceMocks);

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

describe("field projects service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileServiceMocks.getFileDownloadUrl.mockResolvedValue({ url: "https://signed.example/photo.jpg" });
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

    const result = await listFieldProjects(db, "field-1", { search: "roof", page: 2, perPage: 10 });

    expect(result).toEqual({
      projects: [{
        id: "deal-1",
        name: "Roof Repair",
        dealNumber: "TR-100",
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

    const result = await listStarredFieldProjects(db, "field-1");

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
    await expect(starFieldProject(starDb, "field-1", "deal-1")).resolves.toEqual({ starred: true });
    expect(starDb.execute).toHaveBeenCalledTimes(2);

    const unstarDb = tenantDb([[]]);
    await expect(unstarFieldProject(unstarDb, "field-1", "deal-1")).resolves.toEqual({ starred: false });
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
      }],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
    });

    const result = await listFieldProjectPhotos(db, "deal-1", { categories: ["damage"] });

    expect(fileServiceMocks.getDealPhotoTimeline).toHaveBeenCalledWith(db, "deal-1", 1, 200, {
      categories: ["damage"],
    });
    expect(result.photos[0]).toEqual(expect.objectContaining({
      id: "photo-1",
      imageUrl: "https://signed.example/photo.jpg",
      category: "photo",
      photoCategory: "damage",
      address: "123 Main St",
    }));
    expect(JSON.stringify(result.photos[0])).not.toContain("r2Key");
    expect(JSON.stringify(result.photos[0])).not.toContain("r2Bucket");
  });
});
