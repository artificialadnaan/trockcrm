import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateSessionToken } from "./auth/validateSessionToken.js";
import { createMcpServer } from "./server.js";

/**
 * The /mcp router — the machine-facing MCP surface the Anthropic connector calls.
 *
 * AUTH BOUNDARY: validateSessionToken runs first; every request must present a valid Bearer MCP
 * session token, which populates req.mcpContext. Then a stateless Streamable HTTP transport handles
 * the JSON-RPC request with a per-request server bound to that office. `sessionIdGenerator:
 * undefined` selects stateless mode; `enableJsonResponse` returns a single JSON response per POST
 * (no long-lived SSE), which keeps the stub simple and connection-safe.
 */
export function createMcpRouter(): Router {
  const router = Router();

  router.use(validateSessionToken);

  router.post("/", async (req, res) => {
    // validateSessionToken guarantees req.mcpContext is set.
    const context = req.mcpContext!;
    const server = createMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // Log server-side (the generic client response leaks nothing), mirroring errorHandler.
      console.error("[MCP] request failed", err);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: "MCP request failed" } });
      }
    }
  });

  return router;
}
