import { describe, expect, it, vi, beforeEach } from "vitest";

const projectMocks = vi.hoisted(() => ({
  assertActiveFieldProject: vi.fn(),
  // photos-service imports these from projects-service too — stub so the module loads.
  assertAccessibleFieldCaptureTarget: vi.fn(),
}));

const tokenMocks = vi.hoisted(() => ({
  assertPhotosBelongToDeal: vi.fn(),
}));

const filesMocks = vi.hoisted(() => ({
  buildFileDownloadUrlFromRecord: vi.fn(),
  getDealPhotoTimeline: vi.fn(),
  // other imports used elsewhere in photos-service — stubbed so import succeeds.
  confirmUpload: vi.fn(),
  discardPendingUpload: vi.fn(),
  getFileByClientUploadId: vi.fn(),
  getFileDownloadUrl: vi.fn(),
  getPendingUploadMetadata: vi.fn(),
  requestUploadUrl: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({ logPhotoEvent: vi.fn(), logPhotoEvents: vi.fn() }));

vi.mock("../../../src/modules/field/projects-service.js", () => projectMocks);
vi.mock("../../../src/modules/public-photo-tokens/service.js", () => tokenMocks);
vi.mock("../../../src/modules/files/service.js", () => filesMocks);
vi.mock("../../../src/modules/files/audit-log-service.js", () => auditMocks);
vi.mock("../../../src/modules/files/upload-workflow.js", () => ({ recordUploadedFileSideEffects: vi.fn() }));
vi.mock("../../../src/lib/r2-client.js", () => ({
  generateDownloadUrl: vi.fn(),
  generateMockDownloadUrl: vi.fn(),
  isR2Configured: () => true,
}));

const { buildFieldPhotoDownloadUrls } = await import("../../../src/modules/field/photos-service.js");

const db = {} as never;
const input = { userId: "user-1", userRole: "admin" as const, dealId: "deal-1" };

beforeEach(() => {
  vi.clearAllMocks();
  projectMocks.assertActiveFieldProject.mockResolvedValue(undefined);
  tokenMocks.assertPhotosBelongToDeal.mockResolvedValue(undefined);
});

describe("buildFieldPhotoDownloadUrls", () => {
  it("validates access + membership, then returns a presigned attachment URL per R2 photo", async () => {
    filesMocks.getDealPhotoTimeline.mockResolvedValue({
      photos: [
        { id: "p1", r2Key: "office_dallas/deals/1/photo/a.jpg", displayName: "Front", fileExtension: ".jpg", externalUrl: null, fullUrl: null },
      ],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });
    filesMocks.buildFileDownloadUrlFromRecord.mockResolvedValue({ url: "https://r2/a.jpg?dl=1", filename: "Front.jpg" });

    const result = await buildFieldPhotoDownloadUrls(db, { ...input, photoIds: ["p1", "p1"] });

    expect(projectMocks.assertActiveFieldProject).toHaveBeenCalledWith(db, expect.objectContaining({ userId: "user-1" }), "deal-1");
    // Deduped to a single id, and membership is enforced against the deal.
    expect(tokenMocks.assertPhotosBelongToDeal).toHaveBeenCalledWith(db, "deal-1", ["p1"]);
    expect(result).toEqual([{ id: "p1", url: "https://r2/a.jpg?dl=1", filename: "Front.jpg" }]);
    // Each download is audited (so field saves appear in photo history).
    // ONE batched multi-row INSERT, not a per-photo loop: the loop held a single transaction-bound
    // client open for N sequential round-trips, which is what made this route's cap load-bearing.
    expect(auditMocks.logPhotoEvents).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([expect.objectContaining({ photoId: "p1", eventType: "downloaded" })]),
    );
    expect(auditMocks.logPhotoEvent).not.toHaveBeenCalled();
  });

  it("rejects when a requested id is not part of the deal (no URLs minted)", async () => {
    tokenMocks.assertPhotosBelongToDeal.mockRejectedValue(new Error("One or more selected photos are not part of this project."));
    await expect(buildFieldPhotoDownloadUrls(db, { ...input, photoIds: ["foreign"] })).rejects.toThrow("not part of this project");
    expect(filesMocks.buildFileDownloadUrlFromRecord).not.toHaveBeenCalled();
  });

  it("falls back to the external URL for a photo with no R2 copy", async () => {
    filesMocks.getDealPhotoTimeline.mockResolvedValue({
      photos: [{ id: "p2", r2Key: null, displayName: "Ext", fileExtension: ".jpg", externalUrl: "https://cdn/ext.jpg", fullUrl: null }],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });
    const result = await buildFieldPhotoDownloadUrls(db, { ...input, photoIds: ["p2"] });
    expect(result).toEqual([{ id: "p2", url: "https://cdn/ext.jpg", filename: "Ext.jpg" }]);
    expect(filesMocks.buildFileDownloadUrlFromRecord).not.toHaveBeenCalled();
  });
});
