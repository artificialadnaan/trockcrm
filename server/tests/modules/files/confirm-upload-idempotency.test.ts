import { describe, it, expect, vi } from "vitest";

// confirmUpload pulls in the r2-client + db modules at import; stub them so the service loads without a
// real DB/R2 (these idempotency paths never touch R2 — they short-circuit before the token/R2 checks).
vi.mock("../../../src/db.js", () => ({ db: { select: vi.fn() }, pool: {} }));
vi.mock("../../../src/lib/r2-client.js", () => ({
  isR2Configured: () => false,
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  generateMockUploadUrl: vi.fn(),
  generateMockDownloadUrl: vi.fn(),
}));

const { confirmUpload, getFileByClientUploadId } = await import("../../../src/modules/files/service.js");

// Minimal tenantDb whose client-id lookup returns `existing`, and whose insert throws if ever reached —
// proving the idempotent path returns the existing row WITHOUT creating a duplicate.
function tenantDb(existing: Record<string, unknown> | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (existing ? [existing] : []),
        }),
      }),
    }),
    insert: () => {
      throw new Error("insert must not run when the client upload id already has a row");
    },
  };
}

describe("confirmUpload idempotency (resilient upload queue)", () => {
  it("returns the existing row for a known clientUploadId instead of inserting a duplicate", async () => {
    const existing = { id: "file-1", clientUploadId: "cid-1", r2Key: "office_dallas/deals/1/photo/x.jpg" };
    const result = await confirmUpload(tenantDb(existing) as never, "user-1", {
      uploadToken: "tok-gone", // token already consumed by the original confirm
      clientUploadId: "cid-1",
    });
    expect(result).toBe(existing);
  });

  it("getFileByClientUploadId returns the row, or null for an empty id/uploader", async () => {
    const row = { id: "file-9", clientUploadId: "cid-9", uploadedBy: "user-1" };
    await expect(getFileByClientUploadId(tenantDb(row) as never, "cid-9", "user-1")).resolves.toBe(row);
    // Missing id or uploader short-circuits to null (the lookup is scoped to the uploader).
    await expect(getFileByClientUploadId(tenantDb(null) as never, "", "user-1")).resolves.toBeNull();
    await expect(getFileByClientUploadId(tenantDb(row) as never, "cid-9", "")).resolves.toBeNull();
  });
});
