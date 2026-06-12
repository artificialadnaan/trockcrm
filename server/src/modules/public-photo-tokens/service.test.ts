import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());
const tenantQueryMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn(() => ({ query: tenantQueryMock, release: releaseMock })));
const getDealPhotoTimelineMock = vi.hoisted(() => vi.fn());
const buildFileDownloadUrlFromRecordMock = vi.hoisted(() => vi.fn());
const getFileDownloadUrlMock = vi.hoisted(() => vi.fn());
const logPhotoEventMock = vi.hoisted(() => vi.fn());
const getObjectStreamMock = vi.hoisted(() => vi.fn());

const ASSET_BASE = "https://api.test/api/public/photo-viewer";

vi.mock("../../db.js", () => ({
  db: { execute: executeMock },
  pool: { query: queryMock, connect: connectMock },
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: (client: { query: (...args: unknown[]) => unknown }) => ({ execute: client.query }),
}));

vi.mock("../files/service.js", () => ({
  buildFileDownloadUrlFromRecord: buildFileDownloadUrlFromRecordMock,
  getDealPhotoTimeline: getDealPhotoTimelineMock,
  getFileDownloadUrl: getFileDownloadUrlMock,
}));

vi.mock("../files/audit-log-service.js", () => ({
  logPhotoEvent: logPhotoEventMock,
}));

vi.mock("../../lib/r2-client.js", () => ({
  getObjectStream: getObjectStreamMock,
}));

describe("public photo token service", () => {
  beforeEach(() => {
    executeMock.mockReset();
    queryMock.mockReset();
    tenantQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    getDealPhotoTimelineMock.mockReset();
    buildFileDownloadUrlFromRecordMock.mockReset();
    getFileDownloadUrlMock.mockReset();
    logPhotoEventMock.mockReset();
    getObjectStreamMock.mockReset();
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
      photoIds: null,
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
        r2Key: "office_dallas/deals/TR-1/photos/roof-damage.jpg",
      }],
    });
    buildFileDownloadUrlFromRecordMock.mockResolvedValue({ url: "https://r2.test/photo.jpg" });

    const result = await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE });

    // Public exposure lock: the deal payload is property name + address ONLY — no id,
    // no deal number, no token id, no other deal field.
    expect(result.deal).toEqual({ name: "Public Deal", propertyAddress: "100 Main St, Dallas, TX" });
    expect(result.deal).not.toHaveProperty("id");
    expect(result.deal).not.toHaveProperty("dealNumber");
    expect(result).not.toHaveProperty("tokenId");
    expect(result).not.toHaveProperty("contractAmount");
    // Per-photo payload is locked to the image only: { id, imageUrl }. R2-backed photos are
    // served through the token proxy — never a presigned key URL (which embeds the deal
    // number) — so the imageUrl must contain neither the deal number nor an R2 host.
    expect(result.photos[0]).toEqual({
      id: "photo-1",
      imageUrl: `${ASSET_BASE}/raw-token/photos/photo-1/image`,
    });
    expect(result.photos[0].imageUrl).not.toContain("TR-1");
    expect(result.photos[0].imageUrl).not.toContain("r2.test");
    // None of the DROP-list fields may appear: uploader identity, category/sync status,
    // file/EXIF metadata, timestamps, caption, or per-photo location granularity.
    for (const leaked of [
      "uploadedBy", "uploaderName", "uploaderAvatarUrl",
      "photoCategory", "subcategory", "category", "procoreSyncStatus",
      "mimeType", "fileSizeBytes", "fileExtension", "description",
      "takenAt", "createdAt", "displayName",
      "latitude", "longitude", "address", "addressSource", "geocodedAt",
    ]) {
      expect(result.photos[0]).not.toHaveProperty(leaked);
    }
    expect(buildFileDownloadUrlFromRecordMock).not.toHaveBeenCalled();
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
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

    // Non-image record: imageUrl is null (un-strippable, not proxied) and the locked shape
    // still exposes only { id, imageUrl } — the mimeType is not leaked.
    expect(result.photos[0]).toEqual({ id: "photo-pdf", imageUrl: null });
    expect(result.photos[0]).not.toHaveProperty("mimeType");
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("serves R2-backed CompanyCam image records through the proxy instead of external URLs", async () => {
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
    const result = await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE });

    expect(result.photos[0]).toEqual({ id: "photo-1", imageUrl: `${ASSET_BASE}/raw-token/photos/photo-1/image` });
    expect(result.photos[0].imageUrl).not.toContain("r2.test");
    expect(buildFileDownloadUrlFromRecordMock).not.toHaveBeenCalled();
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("does not serve non-JPEG R2 originals (HEIC) publicly — imageUrl is null", async () => {
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
        id: "photo-heic",
        photoCategory: null,
        subcategory: null,
        displayName: "IMG_0421.heic",
        mimeType: "image/heic",
        fileSizeBytes: 10,
        fileExtension: ".heic",
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
        r2Key: "office_dallas/deals/TR-1/photos/companycam_renamed.heic",
      }],
    });
    const result = await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE });

    // HEIC can carry un-strippable GPS, so a non-JPEG R2 original is not exposed on the public viewer.
    expect(result.photos[0]).toMatchObject({ id: "photo-heic", imageUrl: null });
    expect(buildFileDownloadUrlFromRecordMock).not.toHaveBeenCalled();
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("does not let image-looking display names override public non-image storage keys", async () => {
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
        id: "photo-renamed-pdf",
        photoCategory: null,
        subcategory: null,
        displayName: "image.png",
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
        externalThumbnailUrl: null,
        externalUrl: null,
        r2Key: "office_dallas/deals/TR-1/photos/actual.pdf",
      }],
    });

    const result = await getPublicPhotoViewer("raw-token");

    expect(result.photos[0]).toMatchObject({ id: "photo-renamed-pdf", imageUrl: null });
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
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

  it("downloads R2 photos through the proxy (no presigned key URL) and writes public audit metadata", async () => {
    const { getPublicPhotoDownload } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "photo-1", deal_id: "deal-1", category: "photo", display_name: "Roof", file_extension: ".jpg", external_url: null, r2_key: "office_dallas/deals/TR-1/photos/roof.jpg" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPublicPhotoDownload("raw-token", "photo-1", { ipAddress: "127.0.0.1", userAgent: "vitest", assetBaseUrl: ASSET_BASE });

    // Filename is genericized — the internal display_name ("Roof") is never exposed via Content-Disposition.
    expect(result).toEqual({ url: `${ASSET_BASE}/raw-token/photos/photo-1/image?download=1`, filename: "photo.jpg" });
    expect(result.filename).not.toContain("Roof");
    expect(result.url).not.toContain("TR-1");
    expect(getFileDownloadUrlMock).not.toHaveBeenCalled();
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

  it("does NOT fall back to the external original when an R2 photo is a non-JPEG (no metadata leak via download)", async () => {
    const { getPublicPhotoDownload } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // HEIC R2 copy that ALSO has an external CompanyCam URL — must not be downloadable (unstripped).
      .mockResolvedValueOnce({ rows: [{ id: "photo-1", deal_id: "deal-1", category: "photo", display_name: "IMG", file_extension: ".heic", external_url: "https://img.companycam.com/full.heic", r2_key: "office_dallas/deals/TR-1/photos/img.heic", mime_type: "image/heic" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getPublicPhotoDownload("raw-token", "photo-1", { assetBaseUrl: ASSET_BASE })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns a JPEG byte stream (no presigned key) for R2 photos and validates the token read-only", async () => {
    const { getPublicPhotoAsset } = await import("./service.js");
    const fakeStream = (async function* () { yield Buffer.from([0xff, 0xd8, 0xff, 0xd9]); })();
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "photo-1", r2_key: "office_dallas/deals/TR-1/photos/roof.jpg", mime_type: "image/jpeg", display_name: "Roof", file_extension: ".jpg", external_url: null }] })
      .mockResolvedValueOnce({ rows: [] });
    getObjectStreamMock.mockResolvedValue({ stream: fakeStream, contentType: "image/jpeg" });

    const asset = await getPublicPhotoAsset("raw-token", "photo-1");

    expect(asset.kind).toBe("jpeg-stream");
    if (asset.kind === "jpeg-stream") {
      expect(asset.contentType).toBe("image/jpeg");
      // Genericized filename — the internal display_name ("Roof") never reaches Content-Disposition.
      expect(asset.filename).toBe("photo.jpg");
      expect(asset.filename).not.toContain("Roof");
      expect(asset.stream).toBe(fakeStream);
    }
    expect(getObjectStreamMock).toHaveBeenCalledWith("office_dallas/deals/TR-1/photos/roof.jpg");
    // Read-only: the asset path must NOT increment access_count (it validates via SELECT).
    expect(String(executeMock.mock.calls[0][0])).not.toContain("access_count = access_count + 1");
  });

  it("404s non-JPEG R2 originals (HEIC) — un-strippable formats are not served publicly", async () => {
    const { getPublicPhotoAsset } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "photo-1", r2_key: "office_dallas/deals/TR-1/photos/img.heic", mime_type: "image/heic", display_name: "IMG", file_extension: ".heic", external_url: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getPublicPhotoAsset("raw-token", "photo-1")).rejects.toMatchObject({ statusCode: 404 });
    expect(getObjectStreamMock).not.toHaveBeenCalled();
  });

  it("returns an external redirect target for CompanyCam photos without an R2 copy", async () => {
    const { getPublicPhotoAsset } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "photo-1", r2_key: null, mime_type: "image/jpeg", display_name: "CC", file_extension: ".jpg", external_url: "https://img.companycam.com/full.jpg" }] })
      .mockResolvedValueOnce({ rows: [] });

    const asset = await getPublicPhotoAsset("raw-token", "photo-1");

    expect(asset).toEqual({ kind: "external", url: "https://img.companycam.com/full.jpg" });
    expect(getObjectStreamMock).not.toHaveBeenCalled();
  });

  // ─── Token subset support ──────────────────────────────────────────────────────────────────────
  const PHOTO_A = "11111111-1111-1111-1111-111111111111";
  const PHOTO_B = "22222222-2222-2222-2222-222222222222";
  const PHOTO_C = "33333333-3333-3333-3333-333333333333";

  it("persists photo_ids for a SUBSET token (whole-deal token stores NULL::uuid[])", async () => {
    const { generatePublicToken } = await import("./service.js");
    executeMock.mockResolvedValue({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", expires_at: null }] });

    await generatePublicToken({ dealId: "deal-1", tenantId: "tenant-1", createdByUserId: "user-1", photoIds: [PHOTO_A, PHOTO_B] });
    const subsetInsert = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(subsetInsert).toContain("photo_ids");
    expect(subsetInsert).toContain(PHOTO_A);
    expect(subsetInsert).toContain(PHOTO_B);

    executeMock.mockClear();
    await generatePublicToken({ dealId: "deal-1", tenantId: "tenant-1", createdByUserId: "user-1" });
    expect(JSON.stringify(executeMock.mock.calls[0][0])).toContain("NULL::uuid[]");
  });

  it("returns the token's photo subset from verifyAndConsumeToken / resolvePublicPhotoToken", async () => {
    const { verifyAndConsumeToken, resolvePublicPhotoToken } = await import("./service.js");

    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1", photo_ids: [PHOTO_A, PHOTO_B] }] });
    const consumed = await verifyAndConsumeToken("raw");
    expect(consumed.photoIds).toEqual([PHOTO_A, PHOTO_B]);
    expect(JSON.stringify(executeMock.mock.calls[0][0])).toContain("photo_ids");

    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", photo_ids: null }] });
    expect((await resolvePublicPhotoToken("raw")).photoIds).toBeNull();
  });

  it("scopes the public viewer timeline to the token's photo subset", async () => {
    const { getPublicPhotoViewer } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1", photo_ids: [PHOTO_A] }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Public Deal", property_address: "100 Main St" }] })
      .mockResolvedValueOnce({ rows: [] });
    getDealPhotoTimelineMock.mockResolvedValue({ photos: [] });

    await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE });

    expect(getDealPhotoTimelineMock).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      1,
      500,
      expect.objectContaining({ photoIds: [PHOTO_A], includeDeleted: false }),
    );
  });

  it("enforces the subset in the per-photo asset query so an out-of-scope photo is unreachable", async () => {
    const { getPublicPhotoAsset } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", photo_ids: [PHOTO_A] }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // the subset WHERE clause filters the out-of-scope id out
      .mockResolvedValueOnce({ rows: [] });

    await expect(getPublicPhotoAsset("raw-token", PHOTO_C)).rejects.toMatchObject({ statusCode: 404 });
    const filesSql = tenantQueryMock.mock.calls.map((call) => JSON.stringify(call[0])).join(" ");
    expect(filesSql).toContain("ANY");
    expect(filesSql).toContain(PHOTO_A); // the subset is bound into the query
  });

  it("does NOT add a subset filter to the asset query for a whole-deal token", async () => {
    const { getPublicPhotoAsset } = await import("./service.js");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", photo_ids: null }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "photo-1", r2_key: null, mime_type: "image/jpeg", file_extension: ".jpg", external_url: "https://img.companycam.com/full.jpg" }] })
      .mockResolvedValueOnce({ rows: [] });

    await getPublicPhotoAsset("raw-token", "photo-1");
    const filesSql = tenantQueryMock.mock.calls.map((call) => JSON.stringify(call[0])).join(" ");
    expect(filesSql).not.toContain("ANY");
  });

  it("assertPhotosBelongToDeal passes only when every id is an active photo on the deal", async () => {
    const { assertPhotosBelongToDeal } = await import("./service.js");

    const okExec = vi.fn().mockResolvedValue({ rows: [{ id: PHOTO_A }, { id: PHOTO_B }] });
    await expect(assertPhotosBelongToDeal({ execute: okExec } as any, "deal-1", [PHOTO_A, PHOTO_B])).resolves.toBeUndefined();
    const validationSql = JSON.stringify(okExec.mock.calls[0][0]);
    expect(validationSql).toContain("is_active");
    expect(validationSql).toContain("category");

    const missingExec = vi.fn().mockResolvedValue({ rows: [{ id: PHOTO_A }] });
    await expect(assertPhotosBelongToDeal({ execute: missingExec } as any, "deal-1", [PHOTO_A, PHOTO_B])).rejects.toMatchObject({
      statusCode: 400,
    });

    // No id list -> no query at all.
    const emptyExec = vi.fn();
    await expect(assertPhotosBelongToDeal({ execute: emptyExec } as any, "deal-1", [])).resolves.toBeUndefined();
    expect(emptyExec).not.toHaveBeenCalled();
  });
});
