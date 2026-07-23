import rateLimit from "express-rate-limit";
import type { Request } from "express";

// Key by authenticated user ID when available, fall back to IP.
// This prevents a shared office IP from rate-limiting all 30 users together.
function userOrIpKey(req: Request): string {
  return (req as any).user?.id ?? req.ip ?? "unknown";
}

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300, // 300 req/min per user (a page load uses 3-5 calls)
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many auth attempts, please try again later" } },
});

export const publicDueDiligenceGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later",
});

export const publicDueDiligencePostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many decision attempts, please try again later",
});

// Normalize an IP to a stable rate-limit key. express-rate-limit ships an `ipKeyGenerator` helper that IPv6-
// normalizes to a /64 subnet, but it is NOT exported in the installed v7 build (verified: `undefined`), so we
// fall back to the raw req.ip. IPv4 is used verbatim; IPv6 is lower-cased so casing variants share one bucket.
function correctiveActionIpKey(req: Request): string {
  const raw = req.ip ?? "unknown";
  return raw.includes(":") ? raw.toLowerCase() : raw;
}

// Public corrective-action token routes (GET items / POST response / upload url·confirm·discard) are reachable
// with only a ?token and are mounted under /api/field, which has NO apiLimiter. Their authorize step fans the
// arbitrary scorecard UUID across EVERY active office schema (resolveWriteOffice), so a flood carrying any
// nonempty token would generate one DB query per office per request — a cross-office-scan DoS amplifier. Cap
// BEFORE the authorize/scan runs, on EVERY request to these routes (tokenless included).
//
// Key by IP ONLY — deliberately NOT IP+token. A forged ?token only has to pass the 43-char base64url SHAPE gate
// to reach resolveWriteOffice (verification happens AFTER the scan), so an attacker rotating the token would get
// a FRESH bucket per token under an IP+token key and never trip the cap — defeating the exact amplification this
// limiter exists to stop. An IP-only bucket is a shared ceiling that token rotation cannot escape. We also DROP
// the old tokenless `skip`: authorizeCorrectiveAction calls resolveWriteOffice UNCONDITIONALLY (before the
// token/session branch), so a TOKENLESS/session request is ALSO a cross-office-scan amplifier and must be capped
// too — the earlier belief that only the token path amplifies was wrong.
//
// Sizing: ONE full supported response is 50 photos → 1 GET items + 50 presign (upload/url) + 50 confirm
// (upload) + 1 POST response = 102 requests within a minute. Two legit responders behind ONE shared office NAT
// IP now SHARE this bucket (the trade-off of IP-only keying), so size for a couple of concurrent full responses:
// 2 × 102 = 204, rounded up to 220/min for retry/refresh headroom. That comfortably clears legitimate
// concurrent use while a scanning flood — hundreds of GETs/min from one IP, whatever the token — still trips it.
export const CORRECTIVE_ACTION_PUBLIC_LIMIT = 220; // ≈ two full 50-photo responses (204) + headroom, per IP.
export const correctiveActionPublicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: CORRECTIVE_ACTION_PUBLIC_LIMIT,
  keyGenerator: correctiveActionIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});
