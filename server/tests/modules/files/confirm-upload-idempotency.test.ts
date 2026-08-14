import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const evidenceMocks = vi.hoisted(() => ({
  lockForConfirm: vi.fn(),
  markConfirmed: vi.fn(),
}));

// confirmUpload pulls in the r2-client + db modules at import; stub them so the service loads without a
// real DB/R2 (these idempotency paths never touch R2 — they short-circuit before the token/R2 checks).
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

const {
  confirmUpload,
  discardPendingUpload,
  getFileByClientUploadId,
  getPendingUploadMetadata,
  requestUploadUrl,
} = await import("../../../src/modules/files/service.js");

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

/** Programmable confirm DB for the fresh-insert and conflict-winner branches. */
function confirmTenantDb(input: {
  selectResults: Record<string, unknown>[][];
  insertResult: Record<string, unknown>[];
}) {
  let selectIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => input.selectResults[selectIndex++] ?? [],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => input.insertResult,
        }),
      }),
    }),
  };
}

const seededTokens: string[] = [];

function uploadRequestDb() {
  const query = (rows: Record<string, unknown>[]) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => rows,
      then: <TResult1 = Record<string, unknown>[], TResult2 = never>(
        onfulfilled?: ((value: Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows).then(onfulfilled, onrejected),
    };
    return chain;
  };
  return {
    select: (shape: Record<string, unknown>) => query("count" in shape ? [{ count: 0 }] : [{ dealNumber: "TEST-1" }]),
    execute: async () => undefined,
  };
}

async function seedScopedToken(clientUploadId: string) {
  const request = await requestUploadUrl(uploadRequestDb() as never, "test", "user-1", {
    originalFilename: "edit-evidence.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 123,
    category: "other",
    dealId: "deal-1",
    scorecardEditScope: { scorecardId: "card-1", clientUploadId },
  });
  seededTokens.push(request.uploadToken);
  return request.uploadToken;
}

function editBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "binding-1",
    scorecardId: "card-1",
    dealId: "deal-1",
    clientUploadId: "cid-1",
    uploadedBy: "user-1",
    fileId: null,
    state: "authorized",
    createdAt: new Date("2026-07-15T00:00:00Z"),
    updatedAt: new Date("2026-07-15T00:00:00Z"),
    ...overrides,
  };
}

describe("confirmUpload idempotency (resilient upload queue)", () => {
  beforeEach(() => {
    evidenceMocks.lockForConfirm.mockReset().mockResolvedValue(null);
    evidenceMocks.markConfirmed.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const token of seededTokens.splice(0)) discardPendingUpload(token);
  });

  it("returns the existing row for a known clientUploadId instead of inserting a duplicate", async () => {
    const existing = { id: "file-1", clientUploadId: "cid-1", r2Key: "office_dallas/deals/1/photo/x.jpg" };
    const result = await confirmUpload(tenantDb(existing) as never, "user-1", {
      uploadToken: "tok-gone", // token already consumed by the original confirm
      clientUploadId: "cid-1",
    });
    // Deduped → returns the existing row with created=false so the caller skips replaying side effects.
    expect(result).toEqual({ file: existing, created: false });
  });

  it("rejects an ordinary same-user client id instead of adopting it as scorecard edit evidence", async () => {
    const existing = {
      id: "ordinary-file",
      clientUploadId: "cid-1",
      uploadedBy: "user-1",
      dealId: "deal-1",
      r2Key: "office_dallas/deals/1/photo/ordinary.jpg",
    };
    evidenceMocks.lockForConfirm.mockResolvedValue(editBinding());

    await expect(confirmUpload(tenantDb(existing) as never, "user-1", {
      uploadToken: "scorecard-token",
      clientUploadId: "cid-1",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-1" },
      scorecardEditDealId: "deal-1",
    })).rejects.toMatchObject({ statusCode: 409, code: "SCORECARD_EDIT_UPLOAD_SCOPE" });
    expect(evidenceMocks.markConfirmed).not.toHaveBeenCalled();
  });

  it("rejects an existing file recorded by a different scorecard binding", async () => {
    const existing = {
      id: "file-1",
      clientUploadId: "cid-1",
      uploadedBy: "user-1",
      dealId: "deal-1",
      r2Key: "office_dallas/deals/1/photo/x.jpg",
    };
    evidenceMocks.lockForConfirm.mockResolvedValue(editBinding({
      scorecardId: "card-2",
      fileId: "file-1",
      state: "confirmed",
    }));

    await expect(confirmUpload(tenantDb(existing) as never, "user-1", {
      uploadToken: "tok-gone",
      clientUploadId: "cid-1",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-1" },
      scorecardEditDealId: "deal-1",
    })).rejects.toMatchObject({ statusCode: 409, code: "SCORECARD_EDIT_UPLOAD_SCOPE" });
    expect(evidenceMocks.markConfirmed).not.toHaveBeenCalled();
  });

  it("preserves a retry for the exact confirmed scorecard binding and file", async () => {
    const existing = {
      id: "file-1",
      clientUploadId: "cid-1",
      uploadedBy: "user-1",
      dealId: "deal-1",
      r2Key: "office_dallas/deals/1/photo/x.jpg",
    };
    const binding = editBinding({ fileId: "file-1", state: "confirmed" });
    evidenceMocks.lockForConfirm.mockResolvedValue(binding);

    const result = await confirmUpload(tenantDb(existing) as never, "user-1", {
      uploadToken: "tok-gone",
      clientUploadId: "cid-1",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-1" },
      scorecardEditDealId: "deal-1",
    });

    expect(result).toEqual({ file: existing, created: false });
    expect(evidenceMocks.markConfirmed).toHaveBeenCalledWith(expect.anything(), binding, "file-1");
  });

  it("derives a live scoped confirm's deal from its pending token", async () => {
    const token = await seedScopedToken("cid-live-exact");
    const existing = {
      id: "file-live-exact",
      clientUploadId: "cid-live-exact",
      uploadedBy: "user-1",
      dealId: "deal-1",
      r2Key: "office_test/deals/TEST-1/other/existing.pdf",
    };
    const binding = editBinding({
      clientUploadId: "cid-live-exact",
      fileId: "file-live-exact",
      state: "confirmed",
    });
    evidenceMocks.lockForConfirm.mockResolvedValue(binding);

    await expect(confirmUpload(tenantDb(existing) as never, "user-1", {
      uploadToken: token,
      clientUploadId: "cid-live-exact",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-live-exact" },
    })).resolves.toEqual({ file: existing, created: false });

    expect(evidenceMocks.lockForConfirm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      dealId: "deal-1",
      pendingUploadFound: true,
    }));
    expect(evidenceMocks.markConfirmed).toHaveBeenCalledWith(expect.anything(), binding, "file-live-exact");
    expect(getPendingUploadMetadata(token)).toBeNull();
  });

  it("rejects an explicit scorecard deal that conflicts with the live pending token", async () => {
    const token = await seedScopedToken("cid-deal-mismatch");

    await expect(confirmUpload({} as never, "user-1", {
      uploadToken: token,
      clientUploadId: "cid-deal-mismatch",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-deal-mismatch" },
      scorecardEditDealId: "deal-2",
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "SCORECARD_EDIT_UPLOAD_SCOPE",
    });

    expect(evidenceMocks.lockForConfirm).not.toHaveBeenCalled();
    expect(evidenceMocks.markConfirmed).not.toHaveBeenCalled();
    expect(getPendingUploadMetadata(token)).toMatchObject({ dealId: "deal-1" });
  });

  it("retains a live token when binding confirmation fails on an existing-row retry", async () => {
    const token = await seedScopedToken("cid-1");
    const existing = {
      id: "file-1",
      clientUploadId: "cid-1",
      uploadedBy: "user-1",
      dealId: "deal-1",
      r2Key: "office_dallas/deals/1/photo/x.jpg",
    };
    const binding = editBinding({ fileId: "file-1", state: "confirmed" });
    evidenceMocks.lockForConfirm.mockResolvedValue(binding);
    evidenceMocks.markConfirmed.mockRejectedValueOnce(new Error("binding update unavailable"));
    const input = {
      uploadToken: token,
      clientUploadId: "cid-1",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-1" },
      scorecardEditDealId: "deal-1",
    } as const;

    await expect(confirmUpload(tenantDb(existing) as never, "user-1", input))
      .rejects.toThrow("binding update unavailable");
    expect(getPendingUploadMetadata(token)).not.toBeNull();

    await expect(confirmUpload(tenantDb(existing) as never, "user-1", input)).resolves.toEqual({
      file: existing,
      created: false,
    });
    expect(getPendingUploadMetadata(token)).toBeNull();
  });

  it("retains a live token when binding confirmation fails after a fresh insert", async () => {
    const token = await seedScopedToken("cid-fresh");
    const inserted = {
      id: "file-fresh",
      clientUploadId: "cid-fresh",
      uploadedBy: "user-1",
      dealId: "deal-1",
      r2Key: "office_test/unassociated/other/edit-evidence.pdf",
    };
    evidenceMocks.lockForConfirm.mockResolvedValue(editBinding({ clientUploadId: "cid-fresh" }));
    evidenceMocks.markConfirmed.mockRejectedValueOnce(new Error("binding update unavailable"));

    await expect(confirmUpload(confirmTenantDb({
      selectResults: [[]],
      insertResult: [inserted],
    }) as never, "user-1", {
      uploadToken: token,
      clientUploadId: "cid-fresh",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-fresh" },
      scorecardEditDealId: "deal-1",
    })).rejects.toThrow("binding update unavailable");

    expect(getPendingUploadMetadata(token)).not.toBeNull();
  });

  it("retains a live token when binding confirmation fails for the conflict winner", async () => {
    const token = await seedScopedToken("cid-winner");
    const winner = {
      id: "file-winner",
      clientUploadId: "cid-winner",
      uploadedBy: "user-1",
      dealId: "deal-1",
      r2Key: "office_test/unassociated/other/winner.pdf",
      thumbnailR2Key: null,
    };
    evidenceMocks.lockForConfirm.mockResolvedValue(editBinding({
      clientUploadId: "cid-winner",
      fileId: "file-winner",
      state: "confirmed",
    }));
    evidenceMocks.markConfirmed.mockRejectedValueOnce(new Error("binding update unavailable"));

    await expect(confirmUpload(confirmTenantDb({
      selectResults: [[], [winner]],
      insertResult: [],
    }) as never, "user-1", {
      uploadToken: token,
      clientUploadId: "cid-winner",
      scorecardEditScope: { scorecardId: "card-1", clientUploadId: "cid-winner" },
      scorecardEditDealId: "deal-1",
    })).rejects.toThrow("binding update unavailable");

    expect(getPendingUploadMetadata(token)).not.toBeNull();
  });

  it("getFileByClientUploadId returns the row, or null for an empty id/uploader", async () => {
    const row = { id: "file-9", clientUploadId: "cid-9", uploadedBy: "user-1" };
    await expect(getFileByClientUploadId(tenantDb(row) as never, "cid-9", "user-1")).resolves.toBe(row);
    // Missing id or uploader short-circuits to null (the lookup is scoped to the uploader).
    await expect(getFileByClientUploadId(tenantDb(null) as never, "", "user-1")).resolves.toBeNull();
    await expect(getFileByClientUploadId(tenantDb(row) as never, "cid-9", "")).resolves.toBeNull();
  });
});
