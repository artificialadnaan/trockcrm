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
 * Trust ONLY user turns from the client. A password holder could otherwise POST a forged `assistant`
 * turn carrying fabricated figures, which we'd relay to Anthropic as prior context and could seed a
 * number the SQL tools never produced — undercutting this demo's core guarantee that every number
 * comes from a tool. The client only ever relays assistant PROSE (never tool results) and the model
 * re-derives every figure via fresh tool calls each turn, so dropping client-sent assistant turns
 * keeps the conversation's intent (carried by the user turns) without trusting client-authored
 * numbers. Server-reconstructed assistant turns added during a pause_turn continuation stay trusted —
 * they're appended inside streamAiChat from Anthropic's own stream, after this filter.
 */
export function userTurnsOnly(messages: AiChatMessage[]): AiChatMessage[] {
  return messages.filter((m) => m.role === "user");
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

    // Relay only client user turns (see userTurnsOnly) — never client-authored assistant content.
    const userTurns = userTurnsOnly(messages as AiChatMessage[]);
    if (userTurns.length === 0) {
      res.status(400).json({ error: { message: "messages[] must include at least one user turn." } });
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

    // Abort the upstream Anthropic request if the client disconnects mid-stream. Listen on the
    // RESPONSE, not the request: req emits "close" as soon as express.json() drains the body (well
    // before the SSE stream ends), which would abort every turn instantly. res "close" fires on real
    // disconnect (writableFinished=false) or on normal completion (writableFinished=true) — only the
    // former should abort.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as Response & { flushHeaders?: () => void }).flushHeaders?.();

    await streamAiChat(res, {
      messages: userTurns,
      system: buildSystemPrompt(),
      mcpUrl,
      mcpToken,
      apiKey,
      signal: controller.signal,
    });
  });

  return router;
}
