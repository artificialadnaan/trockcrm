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

// Public corrective-action token routes (GET items / POST response / upload url·confirm·discard) are reachable
// with only a ?token and are mounted under /api/field, which has NO apiLimiter. Their authorize step fans the
// arbitrary scorecard UUID across EVERY active office schema (resolveWriteOffice), so an unauthenticated flood
// carrying any nonempty token would generate one DB query per office per request — a cross-office-scan DoS
// amplifier. Cap BEFORE the authorize/scan runs. Skips the (no-token) session path so authenticated/session
// behavior is unchanged (it's already covered by the field-session middleware and isn't an amplifier).
//
// Sizing: ONE full supported response is 50 photos → 1 GET items + 50 presign (upload/url) + 50 confirm
// (upload) + 1 POST response = 102 requests, all within a minute. A 60/min cap 429s partway through
// (~photo 30). So set max well above one complete response (110) with headroom for a retry/refresh, while a
// scanning flood — hundreds of GETs/min — still trips it. We also key by IP+token so two distinct LEGIT
// responders behind ONE shared office IP (each with their own recipient-bound token) get SEPARATE buckets and
// don't throttle each other; an anonymous scan varying the token can't grow its budget past the shared-IP
// portion because a garbage/absent token collapses onto the IP-only bucket (the `unknown` token key).
export const correctiveActionPublicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 110, // ≥ one full 50-photo response (102 requests) + headroom, per IP+token
  keyGenerator: (req: Request) => {
    const ip = req.ip ?? "unknown";
    const token = typeof req.query.token === "string" && req.query.token.trim() ? req.query.token.trim() : "";
    // IP+token: distinct legit responders (distinct tokens) behind a shared IP get separate buckets. A missing
    // token collapses to the IP-only bucket, so a tokenless/garbage scan can't multiply its allowance.
    return token ? `${ip}:${token}` : ip;
  },
  // Only limit the PUBLIC token path (a nonempty ?token, which reaches the cross-office scan unauthenticated).
  // A session request (no token) is skipped so authenticated/session behavior is unchanged — it's already
  // covered by the field-session middleware and is not a cross-office-scan amplifier.
  skip: (req: Request) => !(typeof req.query.token === "string" && req.query.token.trim()),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});
