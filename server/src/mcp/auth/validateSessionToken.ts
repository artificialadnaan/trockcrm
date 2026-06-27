import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../../middleware/error-handler.js";
import { getMcpSessionSecret } from "./secret.js";
import { MCP_AUDIENCE, DEMO_SCOPE, DEMO_OFFICE } from "./contract.js";

/**
 * Express middleware guarding the /mcp surface. The MCP session token is presented as a Bearer
 * token by the Anthropic connector (a machine client) — so we read ONLY the Authorization header,
 * never cookies (cookies are the browser vector, and this token must never touch the browser).
 *
 * Verifies signature + audience + expiry with the dedicated MCP_SESSION_SECRET, then enforces the
 * single-tenant demo invariant: the token MUST carry an expiry, MUST be bound to DEMO_OFFICE
 * (office_dallas) — not merely some allowlisted office — and MUST be read_all scope. office_dallas
 * is a member of KNOWN_OFFICE_SCHEMAS by type, and withOfficeSchema re-checks the allowlist
 * downstream. On success attaches req.mcpContext; on ANY failure → 401 (no leak of which check
 * failed).
 */
export function validateSessionToken(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : undefined;
    if (!token) throw new AppError(401, "MCP session token required");

    let claims: { office?: unknown; scope?: unknown; exp?: unknown };
    try {
      claims = jwt.verify(token, getMcpSessionSecret(), {
        audience: MCP_AUDIENCE,
        algorithms: ["HS256"],
      }) as { office?: unknown; scope?: unknown; exp?: unknown };
    } catch {
      throw new AppError(401, "Invalid MCP session token");
    }

    // jwt.verify only enforces exp when present — require it so a no-expiry token can't live forever.
    if (typeof claims.exp !== "number") throw new AppError(401, "Invalid MCP session token");
    // Single-tenant demo: bind to Dallas specifically, not just any allowlisted office.
    if (claims.office !== DEMO_OFFICE) throw new AppError(401, "Invalid MCP session token");
    if (claims.scope !== DEMO_SCOPE) throw new AppError(401, "Invalid MCP session token");

    req.mcpContext = { office: DEMO_OFFICE, scope: DEMO_SCOPE };
    next();
  } catch (err) {
    next(err);
  }
}
