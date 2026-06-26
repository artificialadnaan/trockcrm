import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../../middleware/error-handler.js";
import { getMcpSessionSecret } from "./secret.js";
import { isKnownOfficeSchema } from "./officeSchemas.js";
import { MCP_AUDIENCE, DEMO_SCOPE } from "./contract.js";

/**
 * Express middleware guarding the /mcp surface. The MCP session token is presented as a Bearer
 * token by the Anthropic connector (a machine client) — so we read ONLY the Authorization header,
 * never cookies (cookies are the browser vector, and this token must never touch the browser).
 *
 * Verifies signature + audience + expiry with the dedicated MCP_SESSION_SECRET, then re-checks the
 * office claim against the allowlist (defense-in-depth: even a validly-signed token cannot bind to
 * an unknown schema) and the scope. On success attaches req.mcpContext; on ANY failure → 401 with
 * a generic message (no leak of which check failed).
 */
export function validateSessionToken(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : undefined;
    if (!token) throw new AppError(401, "MCP session token required");

    let claims: { office?: unknown; scope?: unknown };
    try {
      claims = jwt.verify(token, getMcpSessionSecret(), {
        audience: MCP_AUDIENCE,
        algorithms: ["HS256"],
      }) as { office?: unknown; scope?: unknown };
    } catch {
      throw new AppError(401, "Invalid MCP session token");
    }

    // Allowlist check: office must be a known tenant schema. It is used downstream only to SELECT a
    // whitelisted schema and is never interpolated into SQL.
    if (!isKnownOfficeSchema(claims.office)) throw new AppError(401, "Invalid MCP session token");
    if (claims.scope !== DEMO_SCOPE) throw new AppError(401, "Invalid MCP session token");

    req.mcpContext = { office: claims.office, scope: DEMO_SCOPE };
    next();
  } catch (err) {
    next(err);
  }
}
