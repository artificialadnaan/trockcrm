import { Router, type Request, type Response, type NextFunction } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { authMiddleware } from "../../middleware/auth.js";
import { requireCrmUser } from "../../middleware/field-auth.js";
import { requireAdmin } from "../../middleware/rbac.js";
import {
  generatePublicToken,
  getPublicPhotoAsset,
  getPublicPhotoDownload,
  getPublicPhotoViewer,
  listTokensForDeal,
  revokeToken,
} from "./service.js";
import { getDealById } from "../deals/service.js";
import { findJpegHeaderEnd, stripJpegMetadata } from "./image-metadata.js";
import { publicPhotoShareUrl } from "./public-share-url.js";

// Cap on how much of a JPEG header we'll buffer while looking for Start-Of-Scan before giving up.
// Real EXIF (even with a thumbnail) is well under this; anything larger is treated as unprocessable.
const JPEG_HEADER_CAP_BYTES = 4 * 1024 * 1024;

// Streams a JPEG to the response, stripping leading metadata segments. Only the header region is
// buffered (bounded by JPEG_HEADER_CAP_BYTES); the entropy-coded body is streamed chunk-by-chunk
// with backpressure, so large photos never get fully buffered in memory.
async function pipeStrippedJpeg(source: AsyncIterable<Uint8Array>, res: Response): Promise<void> {
  const write = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      res.write(b, (err) => (err ? reject(err) : resolve()));
    });
  let buf = Buffer.alloc(0);
  let headerEmitted = false;
  for await (const chunk of source) {
    const c = Buffer.from(chunk);
    if (headerEmitted) {
      await write(c);
      continue;
    }
    buf = Buffer.concat([buf, c]);
    const r = findJpegHeaderEnd(buf);
    if (r === "incomplete") {
      if (buf.length > JPEG_HEADER_CAP_BYTES) throw new AppError(422, "Unprocessable image");
      continue;
    }
    if (r === "invalid") throw new AppError(422, "Unprocessable image");
    await write(stripJpegMetadata(buf.subarray(0, r.sos)));
    await write(buf.subarray(r.sos));
    headerEmitted = true;
    buf = Buffer.alloc(0);
  }
  // Reaching here without ever finding SOS means the object isn't a parseable JPEG (truncated or
  // malformed). We can't guarantee its metadata was stripped, so refuse rather than serve raw bytes.
  if (!headerEmitted) throw new AppError(422, "Unprocessable image");
  res.end();
}

export const publicPhotoViewerRoutes = Router();
export const adminPhotoTokenRoutes = Router();

adminPhotoTokenRoutes.use(authMiddleware);
adminPhotoTokenRoutes.use(requireCrmUser);

function requestContext(req: Request) {
  const userAgentHeader = req.headers["user-agent"];
  return {
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(", ") : userAgentHeader ?? null,
  };
}

// Absolute base URL of THIS API router (where the streaming photo proxy lives), used to build
// token-scoped asset URLs that never expose the presigned R2 object key.
function apiPublicPhotoBaseUrl(req: Request): string {
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}/api/public/photo-viewer`;
}

function sanitizeFilename(name: string): string {
  // Content-Disposition is a latin1 HTTP header — any non-ASCII char (emoji, smart quotes,
  // accented letters) makes res.setHeader throw ERR_INVALID_CHAR → 500. Collapse everything
  // outside printable ASCII to "_" so the header is always safe (also drops control chars).
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/[\r\n"\\]/g, "_").slice(0, 200) || "photo";
}

publicPhotoViewerRoutes.get("/:token", async (req, res, next) => {
  try {
    const result = await getPublicPhotoViewer(req.params.token, { assetBaseUrl: apiPublicPhotoBaseUrl(req) });
    res.json(result);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      res.status(404).json({ error: { message: "Photo link not found" } });
      return;
    }
    next(err);
  }
});

publicPhotoViewerRoutes.get("/:token/photos/:photoId/download", async (req, res, next) => {
  try {
    const result = await getPublicPhotoDownload(req.params.token, req.params.photoId, {
      ...requestContext(req),
      assetBaseUrl: apiPublicPhotoBaseUrl(req),
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      res.status(404).json({ error: { message: "Photo not found" } });
      return;
    }
    next(err);
  }
});

// Streams a single photo through the API: hides the presigned R2 key (which embeds the deal number)
// and strips EXIF/GPS from JPEGs. ?download=1 forces an attachment download.
publicPhotoViewerRoutes.get("/:token/photos/:photoId/image", async (req, res, next) => {
  try {
    const asset = await getPublicPhotoAsset(req.params.token, req.params.photoId);
    // The public viewer page is served from a DIFFERENT origin than this API proxy (the frontend host /
    // trockcam.com vs the API host), so the global helmet `Cross-Origin-Resource-Policy: same-origin` makes
    // the browser block the cross-origin <img> (net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin). Relax CORP to
    // cross-origin for this PUBLIC, already-exposure-locked asset only — identical bytes (deal number still
    // hidden behind the proxy, EXIF still stripped); CORP governs who may embed, not what's served. The
    // global same-origin default is untouched for every other route.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (asset.kind === "external") {
      res.redirect(302, asset.url);
      return;
    }
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", asset.contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${sanitizeFilename(asset.filename)}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (asset.kind === "jpeg-buffer") {
      // Already a freshly re-encoded, metadata-free JPEG (sharp transcode) — send as-is. No
      // pipeStrippedJpeg needed (it's emitted clean, not streamed from a raw original).
      res.end(asset.buffer);
      return;
    }
    await pipeStrippedJpeg(asset.stream, res);
  } catch (err) {
    // If we've already started streaming bytes, we can't change the status — just abort the response.
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : undefined);
      return;
    }
    if (err instanceof AppError && err.statusCode === 404) {
      res.status(404).json({ error: { message: "Photo not found" } });
      return;
    }
    if (err instanceof AppError && err.statusCode === 422) {
      res.status(422).json({ error: { message: "Unprocessable image" } });
      return;
    }
    next(err);
  }
});

adminPhotoTokenRoutes.post(
  "/admin/deals/:dealId/photo-tokens",
  requireAdmin,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dealId = String(req.params.dealId);
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
      const expiresAt = typeof req.body?.expiresAt === "string" && req.body.expiresAt
        ? new Date(req.body.expiresAt)
        : null;
      const result = await generatePublicToken({
        dealId,
        createdByUserId: req.user!.id,
        tenantId: req.user!.activeOfficeId,
        expiresAt,
      });
      await req.commitTransaction!();
      res.status(201).json({
        token: result.token,
        rawToken: result.rawToken,
        url: publicPhotoShareUrl(req, result.rawToken),
      });
    } catch (err) {
      next(err);
    }
  }
);

adminPhotoTokenRoutes.get(
  "/admin/deals/:dealId/photo-tokens",
  requireAdmin,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dealId = String(req.params.dealId);
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
      const tokens = await listTokensForDeal(dealId, req.user!.activeOfficeId);
      await req.commitTransaction!();
      res.json({ tokens });
    } catch (err) {
      next(err);
    }
  }
);

adminPhotoTokenRoutes.post(
  "/admin/photo-tokens/:tokenId/revoke",
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await revokeToken(String(req.params.tokenId), req.user!.id, req.user!.activeOfficeId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);
