import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@trock-crm/shared/types";
import { getOfficeAccess, getUserById, verifyJwt } from "../modules/auth/service.js";
import { getUserLocalAuthGate } from "../modules/auth/local-auth-service.js";
import { AppError } from "./error-handler.js";

type FieldUserRequest = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  tenantId: string;
  active: boolean;
};

const FIELD_APP_ALLOWED_ROLE_SET = new Set<UserRole>([
  "admin",
  "director",
  "rep",
  "construction",
  "field_contractor",
]);

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
    if (!FIELD_APP_ALLOWED_ROLE_SET.has(user.role as UserRole)) {
      throw new AppError(403, "Field app access required");
    }
    if (!user.isActive) {
      throw new AppError(403, "Field user is inactive");
    }

    const authMethod = claims.authMethod;
    if (!authMethod) {
      throw new AppError(401, "Session expired, please sign in again");
    }

    const localAuthGate = await getUserLocalAuthGate(user.id);
    if (
      authMethod === "local"
      && (!localAuthGate.isEnabled || localAuthGate.revokedAt)
    ) {
      throw new AppError(401, "Local login is no longer enabled for this user");
    }
    if (localAuthGate.mustChangePassword) {
      throw new AppError(403, "Field app access requires password change");
    }

    const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
    let activeOfficeId = user.officeId;
    let effectiveRole = user.role as UserRole;

    if (requestedOfficeId && requestedOfficeId !== user.officeId) {
      const access = await getOfficeAccess(user.id, requestedOfficeId);
      if (!access.hasAccess) {
        throw new AppError(403, "No access to requested office");
      }
      activeOfficeId = requestedOfficeId;
      if (access.roleOverride && FIELD_APP_ALLOWED_ROLE_SET.has(access.roleOverride as UserRole)) {
        effectiveRole = access.roleOverride as UserRole;
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
    req.fieldUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      role: effectiveRole,
      tenantId: activeOfficeId,
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
