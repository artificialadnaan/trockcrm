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
    // Account-IDENTITY failures (the account itself is no longer valid for the field app) return 401, NOT
    // 403, so the client treats them like an invalid session and re-prompts login. This is the deactivation
    // backstop for the long-lived (30d) stateless field token: a deactivated or role-revoked user is
    // bounced on their next request (re-login then fails in loginFieldUser, which also rejects inactive /
    // wrong-role accounts -> clean lockout, no loop). 403 is reserved for per-ACTION authorization below.
    if (!FIELD_APP_ALLOWED_ROLE_SET.has(user.role as UserRole)) {
      throw new AppError(401, "Field app access required");
    }
    if (!user.isActive) {
      throw new AppError(401, "Field user is inactive");
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
    // Account-state gate -> 401 (treated as an invalid session) for consistency with the identity checks
    // above. NOTE: loginFieldUser does NOT block must-change-password, so on a client without a
    // change-password flow (mobile) the user is bounced to login and re-login won't clear the gate until
    // the password is changed elsewhere — same as the pre-401-only behavior. Follow-up: a mobile
    // change-password flow or a login-time block would make this UX clean.
    if (localAuthGate.mustChangePassword) {
      throw new AppError(401, "Field app access requires password change");
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

export function isCrmUserRole(role: UserRole | string | null | undefined) {
  return typeof role === "string" && role !== "field_contractor";
}

export function requireCrmUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new AppError(401, "Authentication required"));
    return;
  }
  if (!isCrmUserRole(req.user.role as UserRole)) {
    next(new AppError(403, "CRM access required"));
    return;
  }
  next();
}
