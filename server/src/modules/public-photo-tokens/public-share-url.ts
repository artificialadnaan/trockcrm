import type { Request } from "express";

// Absolute base URL of the public photo-viewer web app (where `/p/<token>` is served). Prefers the
// configured FRONTEND_URL; falls back to the request's own proto + host. Shared by the admin token
// route and the field share endpoint so both mint identical public links.
export function publicViewerBaseUrl(req: Request): string {
  const configured = process.env.FRONTEND_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

// Full, shareable public link for a raw (unhashed) token.
export function publicPhotoShareUrl(req: Request, rawToken: string): string {
  return `${publicViewerBaseUrl(req)}/p/${encodeURIComponent(rawToken)}`;
}
