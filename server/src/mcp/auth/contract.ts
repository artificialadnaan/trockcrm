import type { OfficeSchema } from "./officeSchemas.js";

/**
 * The auth context attached to a request after {@link validateSessionToken} accepts an
 * MCP session token. RED's tools read `office` from here (never from model/tool input) and
 * use it only to SELECT a whitelisted tenant schema — the office is never interpolated into SQL.
 *
 * This is a DEMO-grade, single-tenant token: office is always `office_dallas` and scope is
 * always `read_all`. There is no role enum — the page password (DEMO_PASSWORD) is the gate.
 */
export type McpScope = "read_all";

export interface McpAuthContext {
  office: OfficeSchema;
  scope: McpScope;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mcpContext?: McpAuthContext;
    }
  }
}

/** JWT `aud` claim binding a token to this MCP surface. Verified on every request. */
export const MCP_AUDIENCE = "trock-mcp";

/** Short TTL — a fresh token is minted per chat turn server-side. */
export const MCP_TOKEN_TTL_SECONDS = 300;

/**
 * The single tenant this demo is bound to. Typed as OfficeSchema so it must be a member of the
 * {@link KNOWN_OFFICE_SCHEMAS} allowlist at compile time.
 */
export const DEMO_OFFICE: OfficeSchema = "office_dallas";

/** The only scope this demo issues. */
export const DEMO_SCOPE: McpScope = "read_all";
