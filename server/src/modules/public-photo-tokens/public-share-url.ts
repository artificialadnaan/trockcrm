import type { Request } from "express";

// Absolute base URL of the public photo-viewer web app (where `/p/<token>` is served). This is a
// CUSTOMER-FACING link, so it should be a branded public domain, not a raw Railway subdomain.
//
// IMPORTANT — point PUBLIC_SHARE_BASE_URL at a host served by the SERVER/API service itself (the one
// that serves BOTH the `/p` viewer SPA and `/api`), e.g. https://photos.trockcam.com → the API service.
// That keeps the viewer SAME-ORIGIN with the API, so NO API CORS allow-list and NO client api-base
// mapping are needed. Do NOT use the field/capture host (trockcam.com) — it serves the field app, which
// has no `/p` route — and an SPA-only frontend host would additionally require client/src/lib/api.ts
// host-mapping + a CORS entry. Precedence:
//   1. PUBLIC_SHARE_BASE_URL — dedicated config for this public surface (the branded, same-origin host).
//   2. FRONTEND_URL — the general CRM frontend URL (back-compat; also drives CORS, so we don't overload
//      it for branding — hence the dedicated var above).
//   3. the request's own proto + host (last-resort dev fallback).
// Config-driven (no hardcoded domain) so it works across environments. Shared by the admin token route
// and the field share endpoint so both mint identical public links.
export function publicViewerBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_SHARE_BASE_URL?.trim() || process.env.FRONTEND_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

// Full, shareable public link for a raw (unhashed) token.
export function publicPhotoShareUrl(req: Request, rawToken: string): string {
  return `${publicViewerBaseUrl(req)}/p/${encodeURIComponent(rawToken)}`;
}
