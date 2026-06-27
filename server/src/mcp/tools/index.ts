import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "../auth/contract.js";
import { registerDescribeCapabilities } from "./describeCapabilities.js";
import { registerGetPipelineSummary } from "./getPipelineSummary.js";

/**
 * Registers all read-only MCP tools on a per-request server, bound to the validated auth context.
 * Every data tool scopes its SQL to `context.office` (from the session token only) and composes
 * applyBaseDealFilters; SQL computes every number.
 */
export function registerTools(server: McpServer, context: McpAuthContext): void {
  registerDescribeCapabilities(server);
  registerGetPipelineSummary(server, context);
  // Phase 3 (continued):
  //   registerListDeals(server, context);
  //   registerBidAwardVariance(server, context);
}
