import { Router, type Request, type Response } from "express";
import { mintSessionToken } from "../../mcp/auth/mintSessionToken.js";
import { getAnthropicApiKey, getPublicBaseUrl } from "../../mcp/gate/env.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { streamAiChat, type AiChatMessage } from "./anthropic-stream.js";

function isMessage(value: unknown): value is AiChatMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  // Browser-sent messages carry plain string content only.
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
}

/**
 * POST /api/ai-chat — the demo chat turn. Mounted behind the page gate (requireDemoSession), which
 * also enforces CSRF on this POST. Stateless: the client sends the full message history each call.
 * Mints a FIXED, server-side MCP session token (never seen by the client) and hands it to Anthropic
 * as the connector authorization, then streams the response to the client over SSE.
 */
export function createAiChatRouter(): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const messages = (req.body as { messages?: unknown } | undefined)?.messages;
    if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isMessage)) {
      res.status(400).json({ error: { message: "Request body must include a non-empty messages[] array." } });
      return;
    }

    let apiKey: string;
    let mcpUrl: string;
    try {
      apiKey = getAnthropicApiKey();
      mcpUrl = `${getPublicBaseUrl()}/mcp`;
    } catch {
      res.status(503).json({ error: { message: "AI chat is not configured on this service." } });
      return;
    }

    // Token minted server-side, per turn — never exposed to the browser, never a model tool input.
    const mcpToken = mintSessionToken();

    // Abort the upstream Anthropic request if the client disconnects mid-stream.
    const controller = new AbortController();
    req.on("close", () => controller.abort());

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as Response & { flushHeaders?: () => void }).flushHeaders?.();

    await streamAiChat(res, {
      messages: messages as AiChatMessage[],
      system: buildSystemPrompt(),
      mcpUrl,
      mcpToken,
      apiKey,
      signal: controller.signal,
    });
  });

  return router;
}
