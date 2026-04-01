import type { Request, Response, NextFunction } from "express";
import { verifyJwt, getUserById, canAccessOffice } from "../modules/auth/service.js";
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

    // Determine active office (header override or default)
    const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
    let activeOfficeId = user.officeId;

    if (requestedOfficeId && requestedOfficeId !== user.officeId) {
      const hasAccess = await canAccessOffice(user.id, requestedOfficeId);
      if (!hasAccess) {
        throw new AppError(403, "No access to requested office");
      }
      activeOfficeId = requestedOfficeId;
    }

    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      officeId: user.officeId,
      activeOfficeId,
    };

    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(new AppError(401, "Invalid or expired token"));
    }
  }
}
