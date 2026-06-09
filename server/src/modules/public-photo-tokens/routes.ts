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

function publicViewerBaseUrl(req: Request): string {
  const configured = process.env.FRONTEND_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

// Absolute base URL of THIS API router (where the streaming photo proxy lives), used to build
// token-scoped asset URLs that never expose the presigned R2 object key.
function apiPublicPhotoBaseUrl(req: Request): string {
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}/api/public/photo-viewer`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "photo";
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
    if (asset.kind === "external") {
      res.redirect(302, asset.url);
      return;
    }
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", asset.contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${sanitizeFilename(asset.filename)}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(asset.buffer);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      res.status(404).json({ error: { message: "Photo not found" } });
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
        url: `${publicViewerBaseUrl(req)}/p/${encodeURIComponent(result.rawToken)}`,
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
