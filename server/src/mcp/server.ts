import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "./auth/contract.js";

/**
 * Builds the MCP server instance for ONE request, bound to that request's auth context.
 *
 * A fresh server is created per request (stateless transport) so every tool closes over the
 * verified `context.office` — the office comes ONLY from the validated session token
 * (req.mcpContext), never from model/tool input, and is used solely to select a whitelisted schema.
 *
 * Phase 1 registers NO tools — this is the spine RED's read-only tools merge behind in Phase 3.
 */
export function createMcpServer(context: McpAuthContext): McpServer {
  const server = new McpServer({
    name: "trock-data",
    version: "0.1.0",
  });

  // Phase 3 (RED): register read-only tools here, e.g.
  //   registerPipelineSummary(server, context);
  // Every tool computes numbers in SQL and scopes to `context.office`.
  void context;

  return server;
}
