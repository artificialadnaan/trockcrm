import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@trock-crm/shared/types";
import { getUserById, verifyJwt } from "../modules/auth/service.js";
import { AppError } from "./error-handler.js";

type FieldUserRequest = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: "field_contractor";
  tenantId: string;
  active: boolean;
};

declare global {
  namespace Express {
    interface Request {
      fieldUser?: FieldUserRequest;
    }
  }
}

function tokenFromRequest(req: Request): string | undefined {
  return req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
}

export async function requireFieldContractor(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = tokenFromRequest(req);
    if (!token) {
      throw new AppError(401, "Authentication required");
    }

    let claims: ReturnType<typeof verifyJwt>;
    try {
      claims = verifyJwt(token);
    } catch {
      throw new AppError(401, "Authentication required");
    }

    const user = await getUserById(claims.userId);
    if (!user) {
      throw new AppError(401, "Authentication required");
    }
    if (user.role !== "field_contractor") {
      throw new AppError(403, "Field contractor access required");
    }
    if (!user.isActive) {
      throw new AppError(403, "Field user is inactive");
    }

    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      officeId: user.officeId,
      activeOfficeId: user.officeId,
      mustChangePassword: false,
      authMethod: claims.authMethod,
    };
    req.fieldUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      role: "field_contractor",
      tenantId: user.officeId,
      active: user.isActive,
    };

    next();
  } catch (err) {
    next(err);
  }
}

export function requireCrmUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new AppError(401, "Authentication required"));
    return;
  }
  if ((req.user.role as UserRole) === "field_contractor") {
    next(new AppError(403, "CRM access required"));
    return;
  }
  next();
}
