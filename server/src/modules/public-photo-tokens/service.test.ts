import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());
const tenantQueryMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn(() => ({ query: tenantQueryMock, release: releaseMock })));
const getDealPhotoTimelineMock = vi.hoisted(() => vi.fn());
const getFileDownloadUrlMock = vi.hoisted(() => vi.fn());
const logPhotoEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../db.js", () => ({
  db: { execute: executeMock },
  pool: { query: queryMock, connect: connectMock },
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: (client: { query: (...args: unknown[]) => unknown }) => ({ execute: client.query }),
}));

vi.mock("../files/service.js", () => ({
  getDealPhotoTimeline: getDealPhotoTimelineMock,
  getFileDownloadUrl: getFileDownloadUrlMock,
}));

vi.mock("../files/audit-log-service.js", () => ({
  logPhotoEvent: logPhotoEventMock,
}));

describe("public photo token service", () => {
  beforeEach(() => {
    executeMock.mockReset();
    queryMock.mockReset();
    tenantQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    getDealPhotoTimelineMock.mockReset();
    getFileDownloadUrlMock.mockReset();
    logPhotoEventMock.mockReset();
  });

  it("hashes public tokens before persistence and returns the raw token only once", async () => {
    const { generatePublicToken, hashPublicPhotoToken } = await import("./service.js");
    executeMock.mockResolvedValue({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", expires_at: null }] });

    const result = await generatePublicToken({ dealId: "deal-1", tenantId: "tenant-1", createdByUserId: "user-1" });

    expect(result.rawToken).toHaveLength(43);
    expect(result.token).toEqual({ id: "token-1", dealId: "deal-1", tenantId: "tenant-1", expiresAt: null });
    const queryText = String(executeMock.mock.calls[0][0]);
    expect(queryText).not.toContain(result.rawToken);
    expect(hashPublicPhotoToken(result.rawToken)).toHaveLength(64);
  });

  it("verifies valid future-expiring tokens and records access", async () => {
    const { verifyAndConsumeToken, hashPublicPhotoToken } = await import("./service.js");
    executeMock.mockResolvedValue({
      rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }],
    });

    await expect(verifyAndConsumeToken("valid-token")).resolves.toEqual({
      tokenId: "token-1",
      dealId: "deal-1",
      tenantId: "tenant-1",
      createdByUserId: "user-1",
    });
    const queryText = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(queryText).toContain("access_count = access_count + 1");
    expect(queryText).toContain("last_accessed_at = now()");
    expect(queryText).toContain(hashPublicPhotoToken("valid-token"));
    expect(queryText).not.toContain("valid-token");
  });

  it.each(["invalid token format", "missing hash match", "expired token", "revoked token"])(
    "rejects %s as not found",
    async () => {
      const { verifyAndConsumeToken } = await import("./service.js");
      executeMock.mockResolvedValue({ rows: [] });

      await expect(verifyAndConsumeToken("bad-token")).rejects.toMatchObject({
        statusCode: 404,
        message: "Photo link not found",
      });
    }
  );

  it("revokes a token with tenant scope and subsequent verification is rejected", async () => {
    const { revokeToken, verifyAndConsumeToken } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1" }] }).mockResolvedValueOnce({ rows: [] });

    await expect(revokeToken("token-1", "admin-1", "tenant-1")).resolves.toBeUndefined();

    const revokeQuery = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(revokeQuery).toContain("revoked_at = COALESCE");
    expect(revokeQuery).toContain("tenant-1");
    await expect(verifyAndConsumeToken("raw-token")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 404 when revocation misses the tenant scope", async () => {
    const { revokeToken } = await import("./service.js");
    executeMock.mockResolvedValue({ rows: [] });

    await expect(revokeToken("token-1", "admin-1", "tenant-2")).rejects.toMatchObject({
      statusCode: 404,
      message: "Photo token not found",
    });
  });

  it("lists only the requested deal and tenant tokens without exposing raw or hashed values", async () => {
    const { listTokensForDeal } = await import("./service.js");
    executeMock.mockResolvedValue({
      rows: [
        {
          id: "token-active",
          deal_id: "deal-1",
          tenant_id: "tenant-1",
          created_by_user_id: "user-1",
          created_by_name: "Admin User",
          created_at: "2026-05-01T00:00:00.000Z",
          expires_at: null,
          revoked_at: null,
          last_accessed_at: "2026-05-02T00:00:00.000Z",
          access_count: "2",
          token: "hash-not-selected-by-service",
        },
        {
          id: "token-expired",
          deal_id: "deal-1",
          tenant_id: "tenant-1",
          created_by_user_id: "user-2",
          created_by_name: null,
          created_at: "2026-05-01T00:00:00.000Z",
          expires_at: "2020-01-01T00:00:00.000Z",
          revoked_at: null,
          last_accessed_at: null,
          access_count: 0,
        },
        {
          id: "token-revoked",
          deal_id: "deal-1",
          tenant_id: "tenant-1",
          created_by_user_id: "user-3",
          created_by_name: "Director User",
          created_at: "2026-05-01T00:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
          revoked_at: "2026-05-03T00:00:00.000Z",
          last_accessed_at: null,
          access_count: 1,
        },
      ],
    });

    const tokens = await listTokensForDeal("deal-1", "tenant-1");

    expect(JSON.stringify(executeMock.mock.calls[0][0])).toContain("ppt.deal_id");
    expect(JSON.stringify(executeMock.mock.calls[0][0])).toContain("tenant-1");
    expect(tokens.map((token: { status: string }) => token.status)).toEqual(["active", "expired", "revoked"]);
    expect(tokens[0]).not.toHaveProperty("token");
    expect(tokens[0]).not.toHaveProperty("rawToken");
    expect(tokens[1].createdBy.name).toBe("Unknown");
  });

  it("builds a public viewer response with field-safe deal and photo fields", async () => {
    const { getPublicPhotoViewer } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Public Deal", deal_number: "TR-1", property_address: "100 Main St, Dallas, TX", contract_amount: "999999.00" }] })
      .mockResolvedValueOnce({ rows: [] });
    getDealPhotoTimelineMock.mockResolvedValue({
      photos: [{
        id: "photo-1",
        photoCategory: "damage",
        subcategory: null,
        displayName: "Roof damage",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileExtension: ".jpg",
        description: "Damage",
        takenAt: "2026-05-01T00:00:00.000Z",
        createdAt: "2026-05-01T00:01:00.000Z",
        uploadedBy: "user-1",
        uploaderName: "Field User",
        uploaderAvatarUrl: null,
        latitude: null,
        longitude: null,
        address: "100 Main St",
        addressSource: "live_gps",
        geocodedAt: null,
        procoreSyncStatus: "pending",
        externalThumbnailUrl: null,
        externalUrl: null,
      }],
    });
    getFileDownloadUrlMock.mockResolvedValue({ url: "https://r2.test/photo.jpg" });

    const result = await getPublicPhotoViewer("raw-token");

    expect(result.deal).toEqual({ id: "deal-1", name: "Public Deal", dealNumber: "TR-1", propertyAddress: "100 Main St, Dallas, TX" });
    expect(result).not.toHaveProperty("contractAmount");
    expect(result.photos[0]).toMatchObject({ id: "photo-1", imageUrl: "https://r2.test/photo.jpg", procoreSyncStatus: "pending" });
    expect(tenantQueryMock).toHaveBeenCalledWith("COMMIT");
    expect(releaseMock).toHaveBeenCalled();
  });

  it("does not sign non-image records for public viewer image URLs", async () => {
    const { getPublicPhotoViewer } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Public Deal", deal_number: "TR-1", property_address: "100 Main St, Dallas, TX" }] })
      .mockResolvedValueOnce({ rows: [] });
    getDealPhotoTimelineMock.mockResolvedValue({
      photos: [{
        id: "photo-pdf",
        photoCategory: null,
        subcategory: null,
        displayName: "Bid package",
        mimeType: "application/pdf",
        fileSizeBytes: 10,
        fileExtension: ".pdf",
        description: null,
        takenAt: null,
        createdAt: "2026-05-01T00:01:00.000Z",
        uploadedBy: "user-1",
        uploaderName: "Field User",
        uploaderAvatarUrl: null,
        latitude: null,
        longitude: null,
        address: null,
        addressSource: null,
        geocodedAt: null,
        procoreSyncStatus: null,
        externalThumbnailUrl: null,
        externalUrl: null,
        r2Key: "office_dallas/deals/TR-1/photos/bid-package.pdf",
      }],
    });

    const result = await getPublicPhotoViewer("raw-token");

    expect(result.photos[0]).toMatchObject({ id: "photo-pdf", imageUrl: null, mimeType: "application/pdf" });
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("uses signed R2 URLs for public CompanyCam image records instead of external URLs", async () => {
    const { getPublicPhotoViewer } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Public Deal", deal_number: "TR-1", property_address: "100 Main St, Dallas, TX" }] })
      .mockResolvedValueOnce({ rows: [] });
    getDealPhotoTimelineMock.mockResolvedValue({
      photos: [{
        id: "photo-1",
        photoCategory: null,
        subcategory: null,
        displayName: "CompanyCam photo",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileExtension: ".jpg",
        description: null,
        takenAt: null,
        createdAt: "2026-05-01T00:01:00.000Z",
        uploadedBy: "user-1",
        uploaderName: "Field User",
        uploaderAvatarUrl: null,
        latitude: null,
        longitude: null,
        address: null,
        addressSource: null,
        geocodedAt: null,
        procoreSyncStatus: null,
        externalThumbnailUrl: "https://img.companycam.com/thumb.jpg?token=external",
        externalUrl: "https://img.companycam.com/full.jpg?token=external",
        r2Key: "office_dallas/deals/TR-1/photos/companycam_123.jpg",
      }],
    });
    getFileDownloadUrlMock.mockResolvedValue({ url: "https://r2.test/companycam_123.jpg" });

    const result = await getPublicPhotoViewer("raw-token");

    expect(result.photos[0]).toMatchObject({ id: "photo-1", imageUrl: "https://r2.test/companycam_123.jpg" });
    expect(getFileDownloadUrlMock).toHaveBeenCalledWith(expect.anything(), "photo-1");
  });

  it("preserves external image URLs with query strings when no R2 key is present", async () => {
    const { getPublicPhotoViewer } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Public Deal", deal_number: "TR-1", property_address: "100 Main St, Dallas, TX" }] })
      .mockResolvedValueOnce({ rows: [] });
    getDealPhotoTimelineMock.mockResolvedValue({
      photos: [{
        id: "photo-external",
        photoCategory: null,
        subcategory: null,
        displayName: "External photo",
        mimeType: null,
        fileSizeBytes: 10,
        fileExtension: null,
        description: null,
        takenAt: null,
        createdAt: "2026-05-01T00:01:00.000Z",
        uploadedBy: "user-1",
        uploaderName: "Field User",
        uploaderAvatarUrl: null,
        latitude: null,
        longitude: null,
        address: null,
        addressSource: null,
        geocodedAt: null,
        procoreSyncStatus: null,
        externalThumbnailUrl: "https://cdn.example.test/photo.jpg?token=abc",
        externalUrl: null,
        r2Key: null,
      }],
    });

    const result = await getPublicPhotoViewer("raw-token");

    expect(result.photos[0]).toMatchObject({ id: "photo-external", imageUrl: "https://cdn.example.test/photo.jpg?token=abc" });
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown tenant while resolving the public viewer", async () => {
    const { getPublicPhotoViewer } = await import("./service.js");
    executeMock.mockResolvedValue({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(getPublicPhotoViewer("raw-token")).rejects.toMatchObject({ statusCode: 404, message: "Photo link not found" });
  });

  it("downloads only photos on the token deal and writes public audit metadata", async () => {
    const { getPublicPhotoDownload } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "photo-1", deal_id: "deal-1", category: "photo", display_name: "Roof", file_extension: ".jpg", external_url: null }] })
      .mockResolvedValueOnce({ rows: [] });
    getFileDownloadUrlMock.mockResolvedValue({ url: "https://r2.test/photo.jpg", filename: "Roof.jpg" });

    const result = await getPublicPhotoDownload("raw-token", "photo-1", { ipAddress: "127.0.0.1", userAgent: "vitest" });

    expect(result).toEqual({ url: "https://r2.test/photo.jpg", filename: "Roof.jpg" });
    expect(logPhotoEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      photoId: "photo-1",
      eventType: "downloaded",
      userId: "user-1",
      metadata: { viaPublicToken: true, tokenId: "token-1" },
    }));
  });

  it("returns 404 when a download photo does not belong to the token deal", async () => {
    const { getPublicPhotoDownload } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getPublicPhotoDownload("raw-token", "other-photo", {})).rejects.toMatchObject({ statusCode: 404, message: "Photo not found" });
  });
});
