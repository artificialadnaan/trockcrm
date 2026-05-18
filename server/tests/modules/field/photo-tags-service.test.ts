import { beforeEach, describe, expect, it, vi } from "vitest";

const transcriptionMocks = vi.hoisted(() => ({
  getAccessibleFieldPhoto: vi.fn(),
}));

const projectMocks = vi.hoisted(() => ({
  assertActiveFieldProject: vi.fn(),
}));

const fileMocks = vi.hoisted(() => ({
  updateFile: vi.fn(),
}));

vi.mock("../../../src/modules/field/photo-transcription-service.js", () => transcriptionMocks);
vi.mock("../../../src/modules/field/projects-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/field/projects-service.js")>(
    "../../../src/modules/field/projects-service.js"
  );
  return {
    ...actual,
    assertActiveFieldProject: projectMocks.assertActiveFieldProject,
  };
});
vi.mock("../../../src/modules/files/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/files/service.js")>(
    "../../../src/modules/files/service.js"
  );
  return {
    ...actual,
    updateFile: fileMocks.updateFile,
  };
});

const {
  deleteFieldPhotoTag,
  replaceFieldPhotoTags,
  searchFieldProjectTags,
} = await import("../../../src/modules/field/photo-tags-service.js");

describe("photo tags service", () => {
  const db = {
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                { tag: "roofing", createdAt: new Date("2026-05-18T12:00:00.000Z") },
                { tag: "Roofing", createdAt: new Date("2026-05-17T12:00:00.000Z") },
                { tag: "urgent", createdAt: new Date("2026-05-16T12:00:00.000Z") },
              ]),
            })),
          })),
        })),
      })),
    })),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    transcriptionMocks.getAccessibleFieldPhoto.mockResolvedValue({
      id: "photo-1",
      dealId: "deal-1",
      tags: ["roofing", "urgent"],
    });
    projectMocks.assertActiveFieldProject.mockResolvedValue({ id: "deal-1" });
    fileMocks.updateFile.mockResolvedValue({ id: "photo-1", tags: ["roofing", "urgent"] });
  });

  it("replaces photo tags with normalized deduped values and mirrors them to files.tags", async () => {
    const result = await replaceFieldPhotoTags(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, {
      photoId: "photo-1",
      tags: [" roofing ", "urgent", "Roofing"],
    });

    expect(result.tags).toEqual(["roofing", "urgent"]);
    expect(fileMocks.updateFile).toHaveBeenCalledWith(db, "photo-1", {
      tags: ["roofing", "urgent"],
    });
  });

  it("removes one tag case-insensitively and mirrors the remaining list", async () => {
    const result = await deleteFieldPhotoTag(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, {
      photoId: "photo-1",
      tag: "ROOFING",
    });

    expect(result.tags).toEqual(["urgent"]);
    expect(fileMocks.updateFile).toHaveBeenCalledWith(db, "photo-1", {
      tags: ["urgent"],
    });
  });

  it("returns recent unique project tags for autocomplete", async () => {
    const result = await searchFieldProjectTags(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, {
      projectId: "deal-1",
      query: "ro",
    });

    expect(result.tags).toEqual(["roofing", "urgent"]);
    expect(projectMocks.assertActiveFieldProject).toHaveBeenCalledWith(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, "deal-1");
  });
});
