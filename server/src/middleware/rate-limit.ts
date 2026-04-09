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
