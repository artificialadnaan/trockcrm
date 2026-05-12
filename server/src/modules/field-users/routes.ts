import { Router, type NextFunction, type Request, type Response } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { authLimiter } from "../../middleware/rate-limit.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { getTokenCookieOptionsForRequest } from "../auth/http-config.js";
import {
  acceptFieldInvite,
  inviteFieldUser,
  listFieldUsers,
  loginFieldUser,
  previewFieldInvite,
  resendFieldUserInvite,
  revokeFieldUserInvite,
  setFieldUserActive,
  type FieldUserStatusFilter,
} from "./service.js";

function activeTenantId(req: Request): string {
  return req.user!.activeOfficeId ?? req.user!.officeId;
}

export const fieldUserAdminRouter = Router();

fieldUserAdminRouter.get("/", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listFieldUsers({
      tenantId: activeTenantId(req),
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      status: typeof req.query.status === "string" ? req.query.status as FieldUserStatusFilter : "all",
      page: typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1,
      perPage: typeof req.query.perPage === "string" ? parseInt(req.query.perPage, 10) : 25,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

fieldUserAdminRouter.post("/invite", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await inviteFieldUser({
      email: req.body?.email,
      firstName: req.body?.firstName,
      lastName: req.body?.lastName,
      phone: req.body?.phone ?? null,
      tenantId: activeTenantId(req),
      invitedByUserId: req.user!.id,
    });
    return res.status(201).json({ invite: result.invite });
  } catch (err) {
    return next(err);
  }
});

fieldUserAdminRouter.post("/:id/resend-invite", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await resendFieldUserInvite({
      id: req.params.id as string,
      tenantId: activeTenantId(req),
    });
    return res.json({ invite: result.invite });
  } catch (err) {
    return next(err);
  }
});

fieldUserAdminRouter.post("/invites/:id/revoke", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await revokeFieldUserInvite({
      inviteId: req.params.id as string,
      tenantId: activeTenantId(req),
    });
    return res.json({ invite: result.invite });
  } catch (err) {
    return next(err);
  }
});

fieldUserAdminRouter.post("/:id/deactivate", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await setFieldUserActive({
      userId: req.params.id as string,
      tenantId: activeTenantId(req),
      active: false,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

fieldUserAdminRouter.post("/:id/reactivate", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await setFieldUserActive({
      userId: req.params.id as string,
      tenantId: activeTenantId(req),
      active: true,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export const fieldUserAuthRouter = Router();

function tokenCookieOptionsForRequest(req: Request) {
  return getTokenCookieOptionsForRequest(process.env, {
    host: req.get("host"),
    hostname: req.hostname,
    origin: req.headers.origin,
  });
}

function withCsrfToken(res: Response, payload: Record<string, unknown>) {
  const csrfToken = typeof res.locals.csrfToken === "string" ? res.locals.csrfToken : undefined;
  return csrfToken ? { ...payload, csrfToken } : payload;
}

fieldUserAuthRouter.post("/accept-invite", authLimiter, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token || !password) {
      throw new AppError(400, "Token and password are required");
    }

    const result = await acceptFieldInvite({ token, password });
    res.cookie("token", result.token, tokenCookieOptionsForRequest(req));
    res.json(withCsrfToken(res, result));
  } catch (err) {
    next(err);
  }
});

fieldUserAuthRouter.get("/invite-preview", authLimiter, async (req, res, next) => {
  try {
    const token = typeof req.query?.token === "string" ? req.query.token : "";
    if (!token) {
      throw new AppError(400, "Token is required");
    }

    const result = await previewFieldInvite({ token });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldUserAuthRouter.post("/field-login", authLimiter, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) {
      throw new AppError(400, "Email and password are required");
    }

    const result = await loginFieldUser({ email, password });
    res.cookie("token", result.token, tokenCookieOptionsForRequest(req));
    res.json(withCsrfToken(res, result));
  } catch (err) {
    next(err);
  }
});
