import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export type AuthUser = {
  id: string;
  email: string;
  role: "admin" | "director" | "rep" | string;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

function tokenFromRequest(req: Request): string | null {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const cookie = req.cookies?.token;
  return typeof cookie === "string" && cookie ? cookie : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: "Auth is not configured" });

  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });

  try {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    req.user = {
      id: String(payload.sub ?? payload.userId ?? payload.id ?? ""),
      email: String(payload.email ?? ""),
      role: String(payload.role ?? ""),
    };
    if (!req.user.id) return res.status(401).json({ error: "Invalid token" });
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    return next();
  };
}
