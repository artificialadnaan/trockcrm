import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({
  userRole: "admin",
  authEnabled: true,
  authMiddleware: vi.fn((req: any, res: any, next: any) => {
    if (!mocks.authEnabled) {
      res.status(401).json({ error: { message: "Authentication required" } });
      return;
    }
    req.user = {
      id: "admin-1",
      role: mocks.userRole,
      officeId: "tenant-1",
      activeOfficeId: "tenant-1",
    };
    next();
  }),
  requireCrmUser: vi.fn((_req: any, _res: any, next: any) => next()),
  requireAdmin: vi.fn((req: any, res: any, next: any) => {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: { message: "Admin access required" } });
      return;
    }
    next();
  }),
  tenantMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantDb = { execute: vi.fn() };
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  }),
  generatePublicToken: vi.fn(),
  getPublicPhotoViewer: vi.fn(),
  getPublicPhotoDownload: vi.fn(),
  getPublicPhotoAsset: vi.fn(),
  listTokensForDeal: vi.fn(),
  revokeToken: vi.fn(),
  getDealById: vi.fn(),
}));

vi.mock("../../middleware/auth.js", () => ({ authMiddleware: mocks.authMiddleware }));
vi.mock("../../middleware/field-auth.js", () => ({ requireCrmUser: mocks.requireCrmUser }));
vi.mock("../../middleware/rbac.js", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("../../middleware/tenant.js", () => ({ tenantMiddleware: mocks.tenantMiddleware }));
vi.mock("../deals/service.js", () => ({ getDealById: mocks.getDealById }));
vi.mock("./service.js", () => ({
  generatePublicToken: mocks.generatePublicToken,
  getPublicPhotoViewer: mocks.getPublicPhotoViewer,
  getPublicPhotoDownload: mocks.getPublicPhotoDownload,
  getPublicPhotoAsset: mocks.getPublicPhotoAsset,
  listTokensForDeal: mocks.listTokensForDeal,
  revokeToken: mocks.revokeToken,
}));

import { adminPhotoTokenRoutes, publicPhotoViewerRoutes } from "./routes.js";

// Collect a binary (image) response body into a Buffer for byte-level assertions.
function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/public/photo-viewer", publicPhotoViewerRoutes);
  app.use("/api", adminPhotoTokenRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: { message: err.message } });
      return;
    }
    res.status(500).json({ error: { message: err instanceof Error ? err.message : "Internal server error" } });
  });
  return app;
}

describe("public photo token routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userRole = "admin";
    mocks.authEnabled = true;
    mocks.getDealById.mockResolvedValue({ id: "deal-1" });
    mocks.generatePublicToken.mockResolvedValue({
      rawToken: "raw-token",
      token: { id: "token-1", dealId: "deal-1", tenantId: "tenant-1", expiresAt: null },
    });
    mocks.listTokensForDeal.mockResolvedValue([{ id: "token-1", status: "active", accessCount: 0 }]);
    mocks.revokeToken.mockResolvedValue(undefined);
    mocks.getPublicPhotoViewer.mockResolvedValue({
      tokenId: "token-1",
      deal: { id: "deal-1", name: "Public Deal", dealNumber: "TR-1", propertyAddress: "100 Main St" },
      photos: [{ id: "photo-1", displayName: "Roof", imageUrl: "https://example.test/photo.jpg" }],
    });
    mocks.getPublicPhotoDownload.mockResolvedValue({ url: "https://example.test/photo.jpg", filename: "Roof.jpg" });
    delete process.env.FRONTEND_URL;
  });

  it("returns public viewer data and excludes CRM-internal fields", async () => {
    const response = await request(createApp()).get("/api/public/photo-viewer/raw-token");

    expect(response.status).toBe(200);
    expect(response.body.deal).toEqual({ id: "deal-1", name: "Public Deal", dealNumber: "TR-1", propertyAddress: "100 Main St" });
    expect(JSON.stringify(response.body)).not.toContain("contractAmount");
    expect(JSON.stringify(response.body)).not.toContain("leadSource");
    expect(mocks.getPublicPhotoViewer).toHaveBeenCalledWith(
      "raw-token",
      expect.objectContaining({ assetBaseUrl: expect.stringContaining("/api/public/photo-viewer") }),
    );
  });

  it.each(["invalid", "expired", "revoked"])("returns 404 for %s public token", async () => {
    mocks.getPublicPhotoViewer.mockRejectedValueOnce(new AppError(404, "Photo link not found"));

    const response = await request(createApp()).get("/api/public/photo-viewer/bad-token");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { message: "Photo link not found" } });
  });

  it("returns public photo download data and forwards audit context", async () => {
    const response = await request(createApp())
      .get("/api/public/photo-viewer/raw-token/photos/photo-1/download")
      .set("User-Agent", "vitest-agent");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: "https://example.test/photo.jpg", filename: "Roof.jpg" });
    expect(mocks.getPublicPhotoDownload).toHaveBeenCalledWith("raw-token", "photo-1", expect.objectContaining({ userAgent: "vitest-agent" }));
  });

  it("returns 404 for a mismatched public download photo", async () => {
    mocks.getPublicPhotoDownload.mockRejectedValueOnce(new AppError(404, "Photo not found"));

    const response = await request(createApp()).get("/api/public/photo-viewer/raw-token/photos/other-photo/download");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { message: "Photo not found" } });
  });

  it("streams R2 JPEG bytes inline, EXIF-stripped across chunk boundaries, with the right headers", async () => {
    const seg = (m: number, p: Buffer) => { const l = Buffer.alloc(2); l.writeUInt16BE(p.length + 2, 0); return Buffer.concat([Buffer.from([0xff, m]), l, p]); };
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPSLatitude=32.7767", "latin1")])),
      Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x12, 0x34, 0x56, 0xff, 0xd9]),
    ]);
    // Yield in tiny chunks (split mid-segment) to exercise the streaming header buffer.
    const stream = (async function* () { yield jpeg.subarray(0, 6); yield jpeg.subarray(6, 14); yield jpeg.subarray(14); })();
    mocks.getPublicPhotoAsset.mockResolvedValueOnce({ kind: "jpeg-stream", stream, contentType: "image/jpeg", filename: "Roof.jpg" });

    const response = await request(createApp())
      .get("/api/public/photo-viewer/raw-token/photos/photo-1/image")
      .buffer()
      .parse(binaryParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body.toString("latin1")).not.toContain("Exif");
    expect(response.body.toString("latin1")).not.toContain("GPSLatitude");
    expect(response.body.includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true); // image data preserved
    expect(mocks.getPublicPhotoAsset).toHaveBeenCalledWith("raw-token", "photo-1");
  });

  it("forces an attachment download when ?download=1 is set", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    const stream = (async function* () { yield jpeg; })();
    mocks.getPublicPhotoAsset.mockResolvedValueOnce({ kind: "jpeg-stream", stream, contentType: "image/jpeg", filename: "Roof.jpg" });

    const response = await request(createApp())
      .get("/api/public/photo-viewer/raw-token/photos/photo-1/image?download=1")
      .buffer()
      .parse(binaryParser);

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
  });

  it("redirects external (CompanyCam) photos to their CDN URL", async () => {
    mocks.getPublicPhotoAsset.mockResolvedValueOnce({ kind: "external", url: "https://img.companycam.com/full.jpg" });

    const response = await request(createApp()).get("/api/public/photo-viewer/raw-token/photos/photo-1/image").redirects(0);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://img.companycam.com/full.jpg");
  });

  it("returns 422 (not raw bytes) for a JPEG-labeled stream that ends before Start-Of-Scan", async () => {
    const seg = (m: number, p: Buffer) => { const l = Buffer.alloc(2); l.writeUInt16BE(p.length + 2, 0); return Buffer.concat([Buffer.from([0xff, m]), l, p]); };
    // SOI + an APP1 EXIF segment, then EOF — no SOS ever arrives (truncated/malformed upload).
    const headerOnly = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.from("Exif\0\0GPSLatitude=32.7", "latin1"))]);
    const stream = (async function* () { yield headerOnly; })();
    mocks.getPublicPhotoAsset.mockResolvedValueOnce({ kind: "jpeg-stream", stream, contentType: "image/jpeg", filename: "x.jpg" });

    const response = await request(createApp())
      .get("/api/public/photo-viewer/raw-token/photos/photo-1/image")
      .buffer()
      .parse(binaryParser);

    expect(response.status).toBe(422);
    expect(response.body.toString("latin1")).not.toContain("GPSLatitude");
  });

  it("does not 500 on a non-ASCII display name — Content-Disposition is header-safe", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    const stream = (async function* () { yield jpeg; })();
    mocks.getPublicPhotoAsset.mockResolvedValueOnce({ kind: "jpeg-stream", stream, contentType: "image/jpeg", filename: "roof 📸 “smart”.jpg" });

    const response = await request(createApp())
      .get("/api/public/photo-viewer/raw-token/photos/photo-1/image")
      .buffer()
      .parse(binaryParser);

    expect(response.status).toBe(200);
    const cd = response.headers["content-disposition"];
    // eslint-disable-next-line no-control-regex
    expect(cd).toMatch(/^[\x20-\x7e]*$/); // pure ASCII — no ERR_INVALID_CHAR
    expect(cd).not.toContain("📸");
  });

  it("returns 404 when the proxied photo is not on the token deal", async () => {
    mocks.getPublicPhotoAsset.mockRejectedValueOnce(new AppError(404, "Photo not found"));

    const response = await request(createApp()).get("/api/public/photo-viewer/raw-token/photos/other/image");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { message: "Photo not found" } });
  });

  it("creates an admin public token with raw token shown once and tenant scope", async () => {
    process.env.FRONTEND_URL = "https://crm.trock.test/";

    const response = await request(createApp())
      .post("/api/admin/deals/deal-1/photo-tokens")
      .send({ expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(response.status).toBe(201);
    expect(response.body.rawToken).toBe("raw-token");
    expect(response.body.url).toBe("https://crm.trock.test/p/raw-token");
    expect(mocks.generatePublicToken).toHaveBeenCalledWith({
      dealId: "deal-1",
      createdByUserId: "admin-1",
      tenantId: "tenant-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
  });

  it("requires CRM admin auth before creating public tokens", async () => {
    mocks.authEnabled = false;
    const unauthenticated = await request(createApp()).post("/api/admin/deals/deal-1/photo-tokens").send({});
    expect(unauthenticated.status).toBe(401);

    mocks.authEnabled = true;
    mocks.userRole = "field_contractor";
    const forbidden = await request(createApp()).post("/api/admin/deals/deal-1/photo-tokens").send({});
    expect(forbidden.status).toBe(403);
  });

  it("lists admin public tokens without raw or hashed token values", async () => {
    mocks.listTokensForDeal.mockResolvedValueOnce([{ id: "token-1", status: "active", accessCount: 2 }]);

    const response = await request(createApp()).get("/api/admin/deals/deal-1/photo-tokens");

    expect(response.status).toBe(200);
    expect(response.body.tokens).toEqual([{ id: "token-1", status: "active", accessCount: 2 }]);
    expect(JSON.stringify(response.body)).not.toContain("rawToken");
    expect(JSON.stringify(response.body)).not.toContain("hash");
    expect(mocks.listTokensForDeal).toHaveBeenCalledWith("deal-1", "tenant-1");
  });

  it("enforces tenant deal access before listing tokens", async () => {
    mocks.getDealById.mockResolvedValueOnce(null);

    const response = await request(createApp()).get("/api/admin/deals/other-deal/photo-tokens");

    expect(response.status).toBe(404);
    expect(mocks.listTokensForDeal).not.toHaveBeenCalled();
  });

  it("revokes admin public tokens in the active tenant", async () => {
    const response = await request(createApp()).post("/api/admin/photo-tokens/token-1/revoke").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mocks.revokeToken).toHaveBeenCalledWith("token-1", "admin-1", "tenant-1");
  });
});
