import type { Request, Response, NextFunction } from "express";
import { AppError } from "../../middleware/error-handler.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  isUnsafeHttpMethod,
  isValidCsrfPair,
} from "../../modules/auth/http-config.js";
import { DEMO_SESSION_COOKIE, isValidDemoSession } from "./demoSession.js";

/**
 * Page gate for the demo's browser surface (e.g. POST /api/ai-chat). Requires a valid demo session
 * cookie (401 otherwise). For unsafe methods it ALSO requires a valid CSRF pair, reusing the app's
 * existing CSRF primitives (double-submit cookie + x-csrf-token header) so the cookie+CSRF contract
 * matches the rest of the app (403 on mismatch).
 *
 * NOTE: this gate does NOT protect /mcp — that surface is machine-facing and guarded by
 * validateSessionToken (Bearer) instead, since the Anthropic connector has no browser cookie.
 */
export function requireDemoSession(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!isValidDemoSession(req.cookies?.[DEMO_SESSION_COOKIE])) {
      throw new AppError(401, "Demo login required");
    }
    if (isUnsafeHttpMethod(req.method)) {
      const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
      const headerToken = req.get(CSRF_HEADER_NAME) ?? undefined;
      if (!isValidCsrfPair(cookieToken, headerToken)) {
        throw new AppError(403, "Invalid CSRF token");
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}
