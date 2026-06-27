import type { Response } from "express";
import { writeSse, buildSsePaddingComment } from "../notifications/sse-manager.js";
import { StreamProcessor, type AnthropicStreamEvent } from "./stream-processor.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_BETA = "mcp-client-2025-11-20";
const MODEL = process.env.AI_CHAT_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = 4096;
const MAX_CONTINUATIONS = 8; // bound the pause_turn loop

export interface AiChatMessage {
  role: "user" | "assistant";
  content: unknown;
}

export interface StreamAiChatOptions {
  messages: AiChatMessage[];
  system: string;
  mcpUrl: string;
  /** Minted scoped MCP session token — handed to Anthropic as the connector authorization. */
  mcpToken: string;
  apiKey: string;
  /** Aborts the upstream Anthropic request (e.g. when the SSE client disconnects). */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function blockText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => (c as { text: string }).text)
    .join("");
}

async function* readableToChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an Anthropic Messages SSE byte stream into event objects. Pure (consumes any async iterable
 * of byte chunks), so it's unit-testable with canned frames.
 */
export async function* parseAnthropicSse(
  chunks: AsyncIterable<Uint8Array>
): AsyncGenerator<AnthropicStreamEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frameText = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = frameText
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        // ignore non-JSON frames (e.g. ping comments)
      }
    }
  }
}

/**
 * Reconstructs the assistant's content blocks from the stream so a pause_turn continuation can
 * re-POST the partial turn. Tool blocks arrive whole; text + tool input arrive via deltas.
 */
class AssistantContentAccumulator {
  private readonly byIndex = new Map<number, Record<string, unknown>>();
  private readonly inputJson = new Map<number, string>();
  private readonly resultText = new Map<number, string>();

  observe(evt: AnthropicStreamEvent): void {
    if (evt.type === "content_block_start") {
      const cb = (evt.content_block ?? {}) as Record<string, unknown>;
      const idx = evt.index ?? -1;
      if (cb.type === "text") this.byIndex.set(idx, { type: "text", text: (cb.text as string) ?? "" });
      else this.byIndex.set(idx, { ...cb });
      if (cb.type === "mcp_tool_use") this.inputJson.set(idx, "");
      // Seed tool-result text from any whole-at-start content; deltas append to it below.
      if (cb.type === "mcp_tool_result") this.resultText.set(idx, blockText(cb.content));
    } else if (evt.type === "content_block_delta") {
      const idx = evt.index ?? -1;
      const block = this.byIndex.get(idx);
      const delta = (evt.delta ?? {}) as { type?: string; text?: string; partial_json?: string };
      if (delta.type === "text_delta" && block?.type === "text") {
        block.text = `${block.text as string}${delta.text ?? ""}`;
      } else if (delta.type === "text_delta" && block?.type === "mcp_tool_result") {
        this.resultText.set(idx, (this.resultText.get(idx) ?? "") + (delta.text ?? ""));
      } else if (delta.type === "input_json_delta") {
        this.inputJson.set(idx, (this.inputJson.get(idx) ?? "") + (delta.partial_json ?? ""));
      }
    } else if (evt.type === "content_block_stop") {
      const idx = evt.index ?? -1;
      const block = this.byIndex.get(idx);
      if (block?.type === "mcp_tool_use") {
        const raw = this.inputJson.get(idx);
        try {
          block.input = raw ? JSON.parse(raw) : {};
        } catch {
          block.input = {};
        }
      } else if (block?.type === "mcp_tool_result") {
        // Reconstruct the full result content for the pause_turn replay (whole-at-start OR via deltas).
        block.content = [{ type: "text", text: this.resultText.get(idx) ?? "" }];
      }
    }
  }

  content(): unknown[] {
    return [...this.byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  }
}

/**
 * Drives one /api/ai-chat turn: streams Anthropic's response (with the scoped MCP connector) to the
 * client over SSE, routing every content event through the StreamProcessor (chart seam). Preserves
 * turn state across pause_turn continuations. Emits `meta` first and exactly one terminal `done`.
 */
export async function streamAiChat(res: Response, opts: StreamAiChatOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const processor = new StreamProcessor();
  let messages = [...opts.messages];

  writeSse(res, buildSsePaddingComment()); // warm proxies
  writeSse(res, frame("meta", { turnId: cryptoRandomId() }));

  try {
    for (let continuation = 0; continuation < MAX_CONTINUATIONS; continuation += 1) {
      const resp = await fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": ANTHROPIC_BETA,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          stream: true,
          system: opts.system,
          messages,
          mcp_servers: [{ type: "url", url: opts.mcpUrl, name: "trock-data", authorization_token: opts.mcpToken }],
          tools: [{ type: "mcp_toolset", mcp_server_name: "trock-data" }],
        }),
        signal: opts.signal,
      });

      if (!resp.ok || !resp.body) {
        writeSse(res, frame("error", { message: `Anthropic API error (${resp.status})` }));
        break;
      }

      const accumulator = new AssistantContentAccumulator();
      for await (const evt of parseAnthropicSse(readableToChunks(resp.body))) {
        for (const ce of processor.process(evt)) writeSse(res, frame(ce.type, ce.data));
        accumulator.observe(evt);
      }

      if (processor.stopReason === "pause_turn") {
        messages = [...messages, { role: "assistant", content: accumulator.content() }];
        continue; // continue the server-side tool loop with the same processor/turn state
      }
      break;
    }

    // If we exhausted MAX_CONTINUATIONS while still paused, say so rather than emitting a clean done.
    if (processor.stopReason === "pause_turn") {
      writeSse(res, frame("error", { message: "Chat reached the maximum tool-loop length; stopping early." }));
    }
    for (const ce of processor.finish()) writeSse(res, frame(ce.type, ce.data));
    writeSse(res, frame("done", { stopReason: processor.stopReason }));
  } catch (err) {
    console.error(`[ai-chat] stream failed: ${err instanceof Error ? err.message : "unknown"}`);
    writeSse(res, frame("error", { message: "Chat stream failed" }));
    writeSse(res, frame("done", { stopReason: processor.stopReason }));
  } finally {
    res.end();
  }
}

function cryptoRandomId(): string {
  // Node 18+ global crypto.
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}`;
}
