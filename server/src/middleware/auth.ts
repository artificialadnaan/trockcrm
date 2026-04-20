import type { Request, Response, NextFunction } from "express";
import {
  verifyJwt,
  getUserById,
  getOfficeAccess,
} from "../modules/auth/service.js";
import { getUserLocalAuthGate } from "../modules/auth/local-auth-service.js";
import { AppError } from "./error-handler.js";
import type { AuthenticatedUser } from "@trock-crm/shared/types";

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    // Extract token from cookie or Authorization header
    const token =
      req.cookies?.token ||
      req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      throw new AppError(401, "Authentication required");
    }

    const claims = verifyJwt(token);
    const user = await getUserById(claims.userId);

    if (!user || !user.isActive) {
      throw new AppError(401, "User not found or inactive");
    }

    const localAuthGate = await getUserLocalAuthGate(user.id);
    const authMethod = claims.authMethod;

    if (!authMethod) {
      throw new AppError(401, "Session expired, please sign in again");
    }

    if (
      authMethod === "local"
      && (!localAuthGate.isEnabled || localAuthGate.revokedAt)
    ) {
      throw new AppError(401, "Local login is no longer enabled for this user");
    }

    // Determine active office (header override or default)
    const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
    let activeOfficeId = user.officeId;
    let effectiveRole = user.role;

    if (requestedOfficeId && requestedOfficeId !== user.officeId) {
      const access = await getOfficeAccess(user.id, requestedOfficeId);
      if (!access.hasAccess) {
        throw new AppError(403, "No access to requested office");
      }
      activeOfficeId = requestedOfficeId;
      if (access.roleOverride) {
        effectiveRole = access.roleOverride as typeof user.role;
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: effectiveRole,
      officeId: user.officeId,
      activeOfficeId,
      mustChangePassword: localAuthGate.mustChangePassword,
      authMethod,
    };

    if (
      localAuthGate.mustChangePassword &&
      ![
        "/api/auth/me",
        "/api/auth/logout",
        "/api/auth/local/change-password",
      ].includes(req.originalUrl)
    ) {
      throw new AppError(403, "Password change required");
    }

    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(new AppError(401, "Invalid or expired token"));
    }
  }
}
