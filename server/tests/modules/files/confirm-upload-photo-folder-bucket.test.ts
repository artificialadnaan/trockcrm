import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evidenceMocks = vi.hoisted(() => ({
  lockForConfirm: vi.fn(),
  markConfirmed: vi.fn(),
}));

// Same stub set as confirm-upload-idempotency.test.ts: confirmUpload pulls in the db + r2-client modules
// at import, and these cases never reach R2 (isR2Configured() === false skips the HEAD verification).
vi.mock("../../../src/db.js", () => ({ db: { select: vi.fn() }, pool: {} }));
vi.mock("../../../src/lib/r2-client.js", () => ({
  isR2Configured: () => false,
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  generateMockUploadUrl: (r2Key: string) => ({ uploadUrl: "http://mock-put", r2Key, expiresIn: 3600 }),
  generateMockDownloadUrl: vi.fn(),
}));
vi.mock("../../../src/lib/image-thumbnail.js", () => ({
  generateAndStoreThumbnail: vi.fn(async () => null),
  isThumbnailableImage: vi.fn(() => false),
}));
vi.mock("../../../src/lib/pdf-thumbnail.js", () => ({
  generateAndStorePdfThumbnail: vi.fn(async () => null),
  isPdfThumbnailable: vi.fn(() => false),
}));
vi.mock("../../../src/modules/field/scorecard-evidence-upload.js", () => ({
  lockScorecardEditEvidenceUploadForConfirm: evidenceMocks.lockForConfirm,
  markScorecardEditEvidenceUploadConfirmed: evidenceMocks.markConfirmed,
}));

const { confirmUpload, discardPendingUpload, requestUploadUrl } = await import(
  "../../../src/modules/files/service.js"
);

/**
 * The columns confirmUpload actually writes, captured off the insert. There is deliberately NO `select`:
 * these confirms carry no clientUploadId (no idempotency lookup) and no dealId (no deal-fallback address
 * lookup), so a select reaching this stub means the flow changed and the test should fail loudly.
 */
function capturingTenantDb(captured: { values?: Record<string, unknown> }) {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.values = values;
        return {
          onConflictDoNothing: () => ({ returning: async () => [{ id: "file-1", ...values }] }),
        };
      },
    }),
  };
}

const seededTokens: string[] = [];

/** Mint a real step-1 pending token so the folder path under test is the one the server actually stored. */
async function seedToken(overrides: { category?: "photo" | "contract"; mimeType?: string } = {}) {
  const request = await requestUploadUrl({} as never, "test", "user-1", {
    originalFilename: overrides.category === "contract" ? "scope.pdf" : "IMG_0042.jpg",
    mimeType: overrides.mimeType ?? "image/jpeg",
    fileSizeBytes: 2048,
    category: overrides.category ?? "photo",
    subcategory: "Site Visits",
    allowUnassigned: true,
  });
  seededTokens.push(request.uploadToken);
  return request;
}

// A capture date that can never be the month the suite runs in, so "the takenAt bucket" and "the now()
// bucket" are always distinguishable without freezing the clock.
const TAKEN_AT = "2019-04-07T15:30:00.000Z";

describe("confirmUpload photo folder bucketing", () => {
  beforeEach(() => {
    evidenceMocks.lockForConfirm.mockReset().mockResolvedValue(null);
    evidenceMocks.markConfirmed.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const token of seededTokens.splice(0)) discardPendingUpload(token);
  });

  it("files a photo under its takenAt month, not the month it was uploaded", async () => {
    const request = await seedToken();
    // Step 1 could only bucket by now() — the capture time had not been sent yet. This asserts the premise
    // of the bug, so the case below is proving a real re-derivation and not a coincidence.
    expect(request.folderPath).toBe(`Photos/Site Visits/${new Date().toISOString().slice(0, 7)}`);

    const captured: { values?: Record<string, unknown> } = {};
    await confirmUpload(capturingTenantDb(captured) as never, "user-1", {
      uploadToken: request.uploadToken,
      takenAt: TAKEN_AT,
    });

    expect(captured.values?.folderPath).toBe("Photos/Site Visits/2019-04");
    expect(captured.values?.takenAt).toEqual(new Date(TAKEN_AT));
  });

  it("keeps the presign-time folder path when no takenAt is supplied", async () => {
    const request = await seedToken();

    const captured: { values?: Record<string, unknown> } = {};
    await confirmUpload(capturingTenantDb(captured) as never, "user-1", {
      uploadToken: request.uploadToken,
    });

    expect(captured.values?.folderPath).toBe(request.folderPath);
    expect(captured.values?.takenAt).toBeNull();
  });

  it("falls back to the presign-time folder path when takenAt is unparseable", async () => {
    const request = await seedToken();

    const captured: { values?: Record<string, unknown> } = {};
    // Neither confirm route validates takenAt, so garbage reaches here. An Invalid Date must not reach
    // buildFolderPath (toISOString() throws) nor the column — both inside the request transaction.
    await expect(confirmUpload(capturingTenantDb(captured) as never, "user-1", {
      uploadToken: request.uploadToken,
      takenAt: "not-a-date",
    })).resolves.toMatchObject({ created: true });

    expect(captured.values?.folderPath).toBe(request.folderPath);
    expect(captured.values?.takenAt).toBeNull();
  });

  it("leaves a non-photo alone — only photo paths carry a month bucket", async () => {
    const request = await seedToken({ category: "contract", mimeType: "application/pdf" });

    const captured: { values?: Record<string, unknown> } = {};
    await confirmUpload(capturingTenantDb(captured) as never, "user-1", {
      uploadToken: request.uploadToken,
      takenAt: TAKEN_AT,
    });

    // buildFolderPath appends YYYY-MM for category 'photo' only, so re-deriving a document would be a
    // no-op at best — the guard keeps it from being a silent path rewrite if that ever changes.
    expect(captured.values?.folderPath).toBe("Contracts/Site Visits");
    expect(captured.values?.folderPath).toBe(request.folderPath);
  });
});
