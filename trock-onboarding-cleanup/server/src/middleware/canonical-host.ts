import type { NextFunction, Request, Response } from "express";

const OLD_RAILWAY_HOST = "trock-onboarding-cleanup-production.up.railway.app";
const CANONICAL_CLEANUP_ORIGIN = "https://onboarding.trockcrm.com";

function normalizeHost(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase().split(":")[0] ?? "";
}

export function getCanonicalCleanupRedirect({
  host,
  originalUrl,
  path,
}: {
  host: string | undefined;
  originalUrl: string;
  path: string;
}) {
  if (path === "/api/health") return null;
  if (normalizeHost(host) !== OLD_RAILWAY_HOST) return null;
  return `${CANONICAL_CLEANUP_ORIGIN}${originalUrl}`;
}

export function canonicalCleanupHostRedirect(req: Request, res: Response, next: NextFunction) {
  const redirectUrl = getCanonicalCleanupRedirect({
    host: req.get("host"),
    originalUrl: req.originalUrl,
    path: req.path,
  });

  if (!redirectUrl) return next();
  return res.redirect(301, redirectUrl);
}
