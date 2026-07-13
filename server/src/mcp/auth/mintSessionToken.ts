import jwt from "jsonwebtoken";
import { getMcpSessionSecret } from "./secret.js";
import {
  DEMO_OFFICE,
  DEMO_SCOPE,
  MCP_AUDIENCE,
  MCP_TOKEN_TTL_SECONDS,
} from "./contract.js";

/**
 * Mints a fixed, role-free MCP session token for the demo.
 *
 * Takes NO role/user input. It ALWAYS issues `{ office: "office_dallas", scope: "read_all",
 * aud: "trock-mcp", exp: now + 300s }`, signed with the dedicated MCP_SESSION_SECRET. The office
 * is hardcoded (single-tenant demo) and bound INTO the token — that binding, verified on every
 * request, is the "can't-query-the-wrong-tenant" guarantee.
 *
 * Minted server-side per chat turn and handed to the Anthropic connector. NEVER exposed to the
 * browser, NEVER a tool input the model sees.
 */
export function mintSessionToken(): string {
  return jwt.sign({ office: DEMO_OFFICE, scope: DEMO_SCOPE }, getMcpSessionSecret(), {
    algorithm: "HS256",
    audience: MCP_AUDIENCE,
    expiresIn: MCP_TOKEN_TTL_SECONDS,
  });
}
