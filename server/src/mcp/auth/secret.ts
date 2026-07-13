/**
 * Loads the signing secret for MCP session tokens.
 * SECURITY: dedicated secret (env MCP_SESSION_SECRET), separate from user-auth JWT_SECRET, so an
 * MCP session token can never be verified by the user-auth path and vice-versa. Rotate independently.
 */
export function getMcpSessionSecret(): string {
  const secret = process.env.MCP_SESSION_SECRET;
  const nodeEnv = process.env.NODE_ENV;
  const isLocalDevEnv = nodeEnv === "development" || nodeEnv === "test";
  if (!secret && !isLocalDevEnv) {
    throw new Error("MCP_SESSION_SECRET must be set outside local development/test");
  }
  // Fail fast on the misconfiguration that silently breaks the documented isolation: if the MCP
  // secret equals JWT_SECRET, the two token families share a key and compromising/rotating one
  // affects the other.
  if (secret && secret === process.env.JWT_SECRET) {
    throw new Error("MCP_SESSION_SECRET must be distinct from JWT_SECRET (separate token families)");
  }
  return secret || "dev-mcp-secret-change-in-production";
}
