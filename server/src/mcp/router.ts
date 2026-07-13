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
      // Log a redacted summary (name + message) — NOT the raw exception object, which could carry
      // client-supplied params / backend detail. Restores visibility without leaking.
      const summary = err instanceof Error ? `${err.name}: ${err.message}` : "non-Error thrown";
      console.error(`[MCP] request failed: ${summary}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: "MCP request failed" } });
      }
    }
  });

  // This stateless, JSON-response server supports POST JSON-RPC only — it has no GET SSE side channel
  // and no session to DELETE. Answer other methods with a proper 405 HERE so an authenticated GET
  // (e.g. a spec-compliant client opening the server-to-client stream) doesn't fall through to the
  // SPA catch-all and get index.html back.
  router.all("/", (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method Not Allowed: this MCP endpoint is stateless and accepts POST only." },
    });
  });

  return router;
}
