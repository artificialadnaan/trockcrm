import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * The public viewer used to call `getDealPhotoTimeline(…, 1, 500)` and return `{ deal, photos }` with no
 * pagination whatsoever. A share scoped to more than 500 photos therefore rendered exactly 500 — no
 * error, no notice, no way for the recipient to know anything was missing. It was already misleading
 * production whole-deal links (19 projects hold >500 photos, the largest 2,911), and raising the share
 * cap to 3000 would have made silent truncation the normal case.
 *
 * These tests are the regression guard: the viewer must ASK for the requested page, must report the
 * share's true total, and must never re-introduce a fixed ceiling.
 */

const executeMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());
const tenantQueryMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn(() => ({ query: tenantQueryMock, release: releaseMock })));
const getDealPhotoTimelineMock = vi.hoisted(() => vi.fn());
const getDealPhotoIdsInScopeMock = vi.hoisted(() => vi.fn());
const buildFileDownloadUrlFromRecordMock = vi.hoisted(() => vi.fn());
const getObjectStreamMock = vi.hoisted(() => vi.fn());
const getObjectBufferMock = vi.hoisted(() => vi.fn());
const generateThumbnailBufferMock = vi.hoisted(() => vi.fn());

const ASSET_BASE = "https://api.test/api/public/photo-viewer";

vi.mock("../../../src/db.js", () => ({
  releasePooledClient: (client: any) => client?.release?.(),
  isBrokenConnectionError: () => false,
  db: { execute: executeMock },
  pool: { query: queryMock, connect: connectMock },
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: (client: { query: (...args: unknown[]) => unknown }) => ({ execute: client.query }),
}));

vi.mock("../../../src/modules/files/service.js", () => ({
  buildFileDownloadUrlFromRecord: buildFileDownloadUrlFromRecordMock,
  getDealPhotoTimeline: getDealPhotoTimelineMock,
  getDealPhotoIdsInScope: getDealPhotoIdsInScopeMock,
  getFileDownloadUrl: vi.fn(),
}));

vi.mock("../../../src/modules/files/audit-log-service.js", () => ({ logPhotoEvent: vi.fn() }));

// Keep the real r2-client module so ObjectTooLargeError stays the SAME class the service instanceofs.
vi.mock("../../../src/lib/r2-client.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/lib/r2-client.js")>()),
  getObjectStream: getObjectStreamMock,
  getObjectBuffer: getObjectBufferMock,
}));

vi.mock("../../../src/lib/image-thumbnail.js", () => ({ generateThumbnailBuffer: generateThumbnailBufferMock }));

// A 900-photo share: bigger than the old hard-coded 500 ceiling, so any reintroduced cap shows up.
const TOTAL_PHOTOS = 900;
const PAGE_SIZE = 60;

function photoRow(index: number) {
  return {
    id: `photo-${index}`,
    displayName: `Roof ${index}`,
    mimeType: "image/jpeg",
    fileExtension: ".jpg",
    fileSizeBytes: 10,
    externalThumbnailUrl: null,
    externalUrl: null,
    r2Key: `office_dallas/deals/TR-1/photos/roof-${index}.jpg`,
  };
}

/** Drives the tenant transaction: BEGIN, set_config, the deal SELECT, COMMIT. */
function primeTenant() {
  executeMock.mockResolvedValueOnce({
    rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", created_by_user_id: "user-1", photo_ids: null }],
  });
  queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
  tenantQueryMock
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: "deal-1", name: "Public Deal", property_address: "100 Main St" }] })
    .mockResolvedValueOnce({ rows: [] });
}

function primeTimeline(page: number) {
  const start = (page - 1) * PAGE_SIZE;
  getDealPhotoTimelineMock.mockResolvedValue({
    photos: Array.from({ length: Math.min(PAGE_SIZE, TOTAL_PHOTOS - start) }, (_, i) => photoRow(start + i)),
    pagination: { page, limit: PAGE_SIZE, total: TOTAL_PHOTOS, totalPages: Math.ceil(TOTAL_PHOTOS / PAGE_SIZE) },
  });
}

beforeEach(() => {
  executeMock.mockReset();
  queryMock.mockReset();
  tenantQueryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  getDealPhotoTimelineMock.mockReset();
  getDealPhotoIdsInScopeMock.mockReset();
  buildFileDownloadUrlFromRecordMock.mockReset().mockResolvedValue({ url: "https://r2.test/photo.jpg" });
  getObjectStreamMock.mockReset();
  getObjectBufferMock.mockReset();
  generateThumbnailBufferMock.mockReset();
});

describe("public viewer pagination", () => {
  it("reports the share's TRUE total, not the number of photos on the page", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(1);

    const result = await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE });

    expect(result.photos.length).toBe(PAGE_SIZE);
    // The number that makes truncation detectable: 900, not 60 and not the old 500.
    expect(result.pagination.total).toBe(TOTAL_PHOTOS);
    expect(result.pagination.totalPages).toBe(15);
  });

  it("requests the page it was asked for, with no hard-coded 500 ceiling", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(7);

    await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE, page: 7 });

    const [, , page, limit] = getDealPhotoTimelineMock.mock.calls[0];
    expect(page).toBe(7);
    expect(limit).toBe(60);
    expect(limit).not.toBe(500);
  });

  it("clamps an oversized per-page request so one link can't demand the whole gallery at once", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(1);

    await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE, limit: 5000 });

    expect(getDealPhotoTimelineMock.mock.calls[0][3]).toBe(200);
  });

  it("falls back to page 1 / the default size for junk query params", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(1);

    await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE, page: Number.NaN, limit: -10 });

    const [, , page, limit] = getDealPhotoTimelineMock.mock.calls[0];
    expect(page).toBe(1);
    expect(limit).toBe(60);
  });
});

describe("public viewer image variants", () => {
  it("points the grid at the thumbnail variant and the lightbox at the full-res original", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(1);

    const result = await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE });
    const photo = result.photos[0];

    // The grid was serving full-resolution originals — ~0.58MB each in production, ~1.7GB for a
    // 3000-photo gallery. The tile now asks for the thumbnail; only the opened photo is full-res.
    expect(photo.imageUrl).toContain("variant=thumb");
    expect(photo.fullImageUrl).not.toContain("variant=thumb");
    expect(photo.fullImageUrl).toContain("/photos/photo-0/image");
  });

  it("keeps the exposure lock: still only id + the two proxy URLs, and no presigned R2 key", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(1);

    const result = await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE });

    expect(Object.keys(result.photos[0]).sort()).toEqual(["fullImageUrl", "id", "imageUrl"]);
    const serialized = JSON.stringify(result);
    // The proxy exists so the object key (which embeds the deal number) never reaches the recipient.
    expect(serialized).not.toContain("r2.test");
    expect(serialized).not.toContain("TR-1");
    expect(serialized).not.toContain("Roof 0");
  });
});

/**
 * The grid was being served full-resolution ORIGINALS: the proxy only ever resolved `r2_key`. At an
 * average 0.58 MB per production photo that is ~1.7 GB of image bytes streamed through one Node
 * process to render a single 3000-photo share — the largest single cost in this feature.
 *
 * Only ~19% of production photos have a `thumbnail_r2_key` (the column postdates most of the library
 * and its backfill has never run), so serving ONLY stored thumbnails would leave every legacy project
 * — precisely the big ones — on full-res originals. Hence the on-demand render, and hence its burst
 * cap: without one, N concurrent misses hold N buffers of up to MAX_TRANSCODE_BYTES each.
 */
describe("thumbnail variant on the asset proxy", () => {
  const JPEG_ROW = {
    id: "photo-1",
    r2_key: "office_dallas/deals/TR-1/photos/roof.jpg",
    mime_type: "image/jpeg",
    file_extension: ".jpg",
    external_url: null,
  };

  function primeAsset(row: Record<string, unknown>) {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", photo_ids: null }],
    });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it("streams the stored thumbnail when one exists, with no re-encode", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeAsset({ ...JPEG_ROW, thumbnail_r2_key: "office_dallas/deals/TR-1/photos/thumbs/roof.jpg" });
    getObjectBufferMock.mockResolvedValueOnce({ buffer: Buffer.from("stored-thumb") });

    const asset = await getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" });

    expect(asset).toMatchObject({ kind: "jpeg-buffer", contentType: "image/jpeg" });
    expect(getObjectBufferMock.mock.calls[0][0]).toContain("/thumbs/");
    // The stored thumbnail is already a sharp re-encode, so it needs no second render.
    expect(generateThumbnailBufferMock).not.toHaveBeenCalled();
  });

  it("renders a thumbnail on demand when the photo predates thumbnail_r2_key", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeAsset({ ...JPEG_ROW, thumbnail_r2_key: null });
    getObjectBufferMock.mockResolvedValueOnce({ buffer: Buffer.from("original-bytes") });
    generateThumbnailBufferMock.mockResolvedValueOnce(Buffer.from("rendered-thumb"));

    const asset = await getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" });

    expect(asset).toMatchObject({ kind: "jpeg-buffer" });
    expect(generateThumbnailBufferMock).toHaveBeenCalledOnce();
    // Bounded input: an oversized original must never be fully buffered on this public endpoint.
    expect(getObjectBufferMock.mock.calls[0][1]).toMatchObject({ maxBytes: expect.any(Number) });
  });

  it("falls back to the full-res stream when the on-demand render fails, rather than a broken tile", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeAsset({ ...JPEG_ROW, thumbnail_r2_key: null });
    getObjectBufferMock.mockRejectedValueOnce(new Error("R2 hiccup"));
    getObjectStreamMock.mockResolvedValueOnce({ stream: (async function* () { yield new Uint8Array([1]); })() });

    const asset = await getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" });

    // Correct image, just heavier — a hole in the recipient's gallery would be worse.
    expect(asset.kind).toBe("jpeg-stream");
  });

  it("never thumbnails an undecodable original — HEIC stays a placeholder, never raw bytes", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeAsset({
      id: "photo-heic",
      r2_key: "office_dallas/deals/TR-1/photos/roof.heic",
      thumbnail_r2_key: null,
      mime_type: "image/heic",
      file_extension: ".heic",
      external_url: null,
    });

    await expect(getPublicPhotoAsset("raw-token", "photo-heic", { variant: "thumb" })).rejects.toMatchObject({ statusCode: 404 });
    expect(generateThumbnailBufferMock).not.toHaveBeenCalled();
  });

  it("leaves the full-res variant on the EXIF-stripping stream path", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeAsset({ ...JPEG_ROW, thumbnail_r2_key: "office_dallas/deals/TR-1/photos/thumbs/roof.jpg" });
    getObjectStreamMock.mockResolvedValueOnce({ stream: (async function* () { yield new Uint8Array([1]); })() });

    const asset = await getPublicPhotoAsset("raw-token", "photo-1");

    expect(asset.kind).toBe("jpeg-stream");
    expect(getObjectBufferMock).not.toHaveBeenCalled();
  });
});

describe("on-demand thumbnail admission control", () => {
  function primeConcurrent() {
    // Order-independent priming: these run concurrently, so the tenant statements can interleave.
    executeMock.mockResolvedValue({
      rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", photo_ids: null }],
    });
    queryMock.mockResolvedValue({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock.mockResolvedValue({
      rows: [{
        id: "photo-1",
        r2_key: "office_dallas/deals/TR-1/photos/roof.jpg",
        thumbnail_r2_key: null,
        mime_type: "image/jpeg",
        file_extension: ".jpg",
        external_url: null,
      }],
    });
    generateThumbnailBufferMock.mockResolvedValue(Buffer.from("rendered-thumb"));
    getObjectStreamMock.mockResolvedValue({ stream: (async function* () { yield new Uint8Array([1]); })() });
  }

  it("caps CONCURRENT renders, then queues the rest instead of shedding them to full-res", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeConcurrent();

    // Each in-flight render holds an original buffer of up to MAX_TRANSCODE_BYTES (40MB). A gate we
    // control pins the permits so we can observe how the overflow is handled.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let concurrent = 0;
    let peakConcurrent = 0;
    getObjectBufferMock.mockImplementation(async () => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await gate;
      concurrent -= 1;
      return { buffer: Buffer.from("original-bytes") };
    });

    // 12 simultaneous tiles — a realistic visible window on a share page, and 3x the permit count.
    const all = Array.from({ length: 12 }, () =>
      getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // Never more than the cap decoding at once — that bound is the whole point.
    expect(peakConcurrent).toBeLessThanOrEqual(4);

    openGate();
    const assets = await Promise.all(all);

    // ...and every tile still gets a thumbnail. A plain shed-on-full cap would have handed 4 tiles a
    // thumbnail and streamed 0.58MB originals to the other 8 — silently, on exactly the legacy
    // galleries this feature targets.
    expect(assets.every((asset) => asset.kind === "jpeg-buffer")).toBe(true);
    expect(generateThumbnailBufferMock).toHaveBeenCalledTimes(12);
  });

  it("falls back to full-res once the WAIT QUEUE itself is too deep", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeConcurrent();

    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    getObjectBufferMock.mockImplementation(async () => {
      await gate;
      return { buffer: Buffer.from("original-bytes") };
    });

    // 4 active + 48 queued is the ceiling; the 53rd must not park unboundedly.
    const pinned = Array.from({ length: 52 }, () =>
      getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const shed = await getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" });
    expect(shed.kind).toBe("jpeg-stream");

    openGate();
    await Promise.all(pinned);

    // Permits are returned on completion — a counter that leaked would silently disable thumbnails
    // process-wide after enough requests.
    const afterDrain = await getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" });
    expect(afterDrain.kind).toBe("jpeg-buffer");
  });
});

describe("stale stored thumbnail", () => {
  it("degrades to an on-demand render when thumbnail_r2_key outlives its object", async () => {
    const { getPublicPhotoAsset } = await import("../../../src/modules/public-photo-tokens/service.js");
    executeMock.mockResolvedValueOnce({
      rows: [{ id: "token-1", deal_id: "deal-1", tenant_id: "tenant-1", photo_ids: null }],
    });
    queryMock.mockResolvedValueOnce({ rows: [{ id: "tenant-1", slug: "dallas" }] });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: "photo-1",
        r2_key: "office_dallas/deals/TR-1/photos/roof.jpg",
        thumbnail_r2_key: "office_dallas/deals/TR-1/photos/thumbs/gone.jpg",
        mime_type: "image/jpeg",
        file_extension: ".jpg",
        external_url: null,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    // Thumbnail generation is best-effort and its R2 write is not transactional with the row, so a
    // key can point at an object that was never written (or was removed). That must not 500 a tile.
    getObjectBufferMock
      .mockRejectedValueOnce(new Error("NoSuchKey"))
      .mockResolvedValueOnce({ buffer: Buffer.from("original-bytes") });
    generateThumbnailBufferMock.mockResolvedValueOnce(Buffer.from("rendered-thumb"));

    const asset = await getPublicPhotoAsset("raw-token", "photo-1", { variant: "thumb" });

    expect(asset).toMatchObject({ kind: "jpeg-buffer" });
    expect(generateThumbnailBufferMock).toHaveBeenCalledOnce();
  });
});

/**
 * `access_count` is shown to the sender in the share panel as "N accesses". Before the viewer paged,
 * one recipient opening a link was exactly one request, so the number meant what it said. Paging turned
 * a single visit into up to 50 requests, and counting each of them would have made the metric scale
 * with the SIZE of the share rather than with interest in it — a 3000-photo link would read as ~50
 * visits the moment one person scrolled it.
 */
describe("public viewer access counting", () => {
  /** Renders the SQL text handed to db.execute for the token lookup. */
  function tokenLookupSql(): string {
    return new PgDialect().sqlToQuery(executeMock.mock.calls[0][0]).sql;
  }

  it("counts page 1 as one access (UPDATE ... access_count + 1)", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(1);

    await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE, page: 1 });

    const sqlText = tokenLookupSql();
    expect(sqlText).toContain("access_count");
    expect(sqlText).toMatch(/update/i);
  });

  it("does NOT re-count pages 2+ — one visit is one access, however many pages it takes", async () => {
    const { getPublicPhotoViewer } = await import("../../../src/modules/public-photo-tokens/service.js");
    primeTenant();
    primeTimeline(9);

    await getPublicPhotoViewer("raw-token", { assetBaseUrl: ASSET_BASE, page: 9 });

    const sqlText = tokenLookupSql();
    // Read-only validation, the same helper the per-photo asset endpoint already uses for this reason.
    expect(sqlText).not.toContain("access_count");
    expect(sqlText).toMatch(/select/i);
    // Still fully gated: a revoked or expired link 404s on this path exactly as it does on page 1.
    expect(sqlText).toContain("revoked_at");
    expect(sqlText).toContain("expires_at");
  });
});
