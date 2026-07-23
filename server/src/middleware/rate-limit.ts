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
// amplifier. Cap by IP (these callers are unauthenticated) BEFORE the authorize/scan runs. Keyed on req.ip
// only, so it never rate-limits an authenticated session by user id. Generous enough for a real responder
// working through a card's items + photo uploads, tight enough to blunt an amplification flood.
export const correctiveActionPublicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 req/min per IP
  keyGenerator: (req: Request) => req.ip ?? "unknown",
  // Only limit the PUBLIC token path (a nonempty ?token, which reaches the cross-office scan unauthenticated).
  // A session request (no token) is skipped so authenticated/session behavior is unchanged — it's already
  // covered by the field-session middleware and is not a cross-office-scan amplifier.
  skip: (req: Request) => !(typeof req.query.token === "string" && req.query.token.trim()),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});
