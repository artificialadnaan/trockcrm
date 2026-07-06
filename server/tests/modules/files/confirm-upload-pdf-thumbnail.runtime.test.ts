import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The PR's headline wiring, asserted in isolation: confirmUpload must invoke generateAndStorePdfThumbnail
 * with (pending.r2Key, pending.mimeType) for a PDF and persist the returned key into thumbnailR2Key — and
 * must NOT invoke it for a non-PDF document. R2 stays unconfigured (isR2Configured -> false) so the real
 * raster never runs; the thumbnail helpers are mocked so we observe the call + the inserted value directly.
 *
 * A pending upload is seeded through the REAL requestUploadUrl using a contactId (no dealId): that path
 * makes ZERO tenantDb calls (generateSystemFilename's no-deal branch + no deals lookup), so a trivial
 * insert-capturing tenantDb mock is enough to reach confirmUpload's insert.
 */

vi.mock("../../../src/db.js", () => ({ db: { select: vi.fn() }, pool: {} }));

// R2 unconfigured: requestUploadUrl uses generateMockUploadUrl; confirmUpload skips headObject; the real
// thumbnail helpers would no-op — but we mock them below, so R2 config is irrelevant to the assertion.
vi.mock("../../../src/lib/r2-client.js", () => ({
  isR2Configured: () => false,
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  generateMockUploadUrl: (r2Key: string) => ({ uploadUrl: "http://mock-put", r2Key, expiresIn: 3600 }),
  generateMockDownloadUrl: vi.fn(),
}));

// Image path always misses here, forcing the PDF branch to decide.
const generateAndStoreThumbnail = vi.fn(async () => null);
const isThumbnailableImage = (m: string | null | undefined) =>
  !!m && m.split(";")[0].trim().toLowerCase().startsWith("image/");
vi.mock("../../../src/lib/image-thumbnail.js", () => ({
  generateAndStoreThumbnail,
  isThumbnailableImage,
}));

const PDF_THUMB_KEY = "office_test/thumbs/spec.jpg";
const generateAndStorePdfThumbnail = vi.fn(async () => PDF_THUMB_KEY);
const isPdfThumbnailable = (m: string | null | undefined) =>
  !!m && m.split(";")[0].trim().toLowerCase() === "application/pdf";
vi.mock("../../../src/lib/pdf-thumbnail.js", () => ({
  generateAndStorePdfThumbnail,
  isPdfThumbnailable,
}));

const { requestUploadUrl, confirmUpload } = await import("../../../src/modules/files/service.js");

const CONTACT_ID = "00000000-0000-4000-8000-0000000000c1";

// Minimal tenantDb: requestUploadUrl (no dealId) never selects; confirmUpload's insert is captured and
// echoed back with an id, so we can read the persisted thumbnailR2Key off the returned row.
function captureTenantDb() {
  let inserted: Record<string, unknown> | null = null;
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "new-file-id", ...v }],
          }),
        };
      },
    }),
  };
  return { db, getInserted: () => inserted };
}

async function seedAndConfirm(mimeType: string, originalFilename: string) {
  const { db } = captureTenantDb();
  const req = await requestUploadUrl(db as never, "office_test", "user-1", {
    originalFilename,
    mimeType,
    fileSizeBytes: 1000,
    category: "contract",
    contactId: CONTACT_ID,
  });
  const res = await confirmUpload(db as never, "user-1", { uploadToken: req.uploadToken });
  return { req, res };
}

describe("confirmUpload PDF-thumbnail wiring", () => {
  beforeEach(() => {
    generateAndStoreThumbnail.mockClear();
    generateAndStorePdfThumbnail.mockClear();
  });

  it("calls generateAndStorePdfThumbnail(pending.r2Key, mime) for a PDF and persists the key", async () => {
    const { req, res } = await seedAndConfirm("application/pdf", "spec.pdf");
    expect(generateAndStorePdfThumbnail).toHaveBeenCalledTimes(1);
    expect(generateAndStorePdfThumbnail).toHaveBeenCalledWith(req.r2Key, "application/pdf");
    expect(res.file.thumbnailR2Key).toBe(PDF_THUMB_KEY);
  });

  it("does NOT call generateAndStorePdfThumbnail for a non-PDF document (thumbnailR2Key stays null)", async () => {
    const { res } = await seedAndConfirm(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "contract.docx",
    );
    expect(generateAndStorePdfThumbnail).not.toHaveBeenCalled();
    expect(res.file.thumbnailR2Key).toBeNull();
  });
});
