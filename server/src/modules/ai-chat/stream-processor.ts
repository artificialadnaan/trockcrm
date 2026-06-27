import { FenceSplitter } from "./fence-splitter.js";
import { buildChartFromModelBlock, parseAnalyticsRows, type CapturedAnalyticsResult } from "./chart-seam.js";
import { isAnalyticsTool } from "../../mcp/tools/analyticsToolNames.js";

/**
 * Content events the processor produces from the Anthropic stream. The relay wraps these in SSE
 * frames (chart-seam spec §7); the relay itself adds the surrounding `meta` and `done` frames.
 */
export type ContentEvent =
  | { type: "text"; data: { delta: string } }
  | { type: "chart"; data: { id: string; spec: Record<string, unknown> } }
  | { type: "chart_dropped"; data: { reason: string } }
  | {
      type: "tool_debug";
      data: {
        kind: "tool_use" | "tool_result";
        name?: string;
        server_name?: string;
        toolUseId?: string;
        isError?: boolean;
        rowCount?: number;
        reason?: string;
      };
    };

/** The Anthropic Messages streaming events we consume (only the fields we use). */
export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    server_name?: string;
    tool_use_id?: string;
    is_error?: boolean;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
}

type BlockState =
  | { kind: "text" }
  | { kind: "tool_use" }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; textAccum: string }
  | { kind: "other" };

function extractText(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/**
 * Per-turn capture state machine over the Anthropic stream (chart-seam spec §5). Maintains the
 * turn-global, ordered `analyticsResults` (keyed by tool-use id) and runs text through the fence
 * splitter + chart seam. State persists across `pause_turn` continuations — the relay keeps feeding
 * the same processor — so `analyticsResults` and the fence buffer survive a paused turn.
 */
export class StreamProcessor {
  readonly analyticsResults: CapturedAnalyticsResult[] = [];
  stopReason: string | null = null;

  private readonly fence = new FenceSplitter();
  private readonly blocks = new Map<number, BlockState>();
  private readonly toolUseById = new Map<string, string>();
  private chartSeq = 0;

  process(evt: AnthropicStreamEvent): ContentEvent[] {
    switch (evt.type) {
      case "content_block_start": {
        const cb = evt.content_block ?? {};
        const idx = evt.index ?? -1;
        if (cb.type === "mcp_tool_use") {
          if (cb.id && cb.name) this.toolUseById.set(cb.id, cb.name);
          this.blocks.set(idx, { kind: "tool_use" });
          return [
            { type: "tool_debug", data: { kind: "tool_use", name: cb.name, server_name: cb.server_name, toolUseId: cb.id } },
          ];
        }
        if (cb.type === "mcp_tool_result") {
          // Server-executed results often arrive WHOLE at start; accumulate here AND on any delta.
          this.blocks.set(idx, {
            kind: "tool_result",
            toolUseId: cb.tool_use_id ?? "",
            isError: cb.is_error === true,
            textAccum: extractText(cb.content),
          });
          return [];
        }
        if (cb.type === "text") {
          this.blocks.set(idx, { kind: "text" });
          return cb.text ? this.feedText(cb.text) : [];
        }
        this.blocks.set(idx, { kind: "other" });
        return [];
      }
      case "content_block_delta": {
        const block = this.blocks.get(evt.index ?? -1);
        const delta = evt.delta ?? {};
        if (block?.kind === "text" && delta.type === "text_delta") {
          return this.feedText(delta.text ?? "");
        }
        if (block?.kind === "tool_result" && delta.type === "text_delta") {
          block.textAccum += delta.text ?? "";
        }
        return []; // input_json_delta (tool input) is ignored for charts
      }
      case "content_block_stop": {
        const block = this.blocks.get(evt.index ?? -1);
        if (block?.kind === "tool_result") return this.finalizeToolResult(block);
        return [];
      }
      case "message_delta": {
        if (evt.delta?.stop_reason != null) this.stopReason = evt.delta.stop_reason;
        return [];
      }
      default:
        return [];
    }
  }

  /** Terminal flush: an unclosed chart fence is dropped (never emitted as text). */
  finish(): ContentEvent[] {
    return this.mapFenceEvents(this.fence.end());
  }

  private feedText(text: string): ContentEvent[] {
    return this.mapFenceEvents(this.fence.push(text));
  }

  private mapFenceEvents(events: ReturnType<FenceSplitter["push"]>): ContentEvent[] {
    const out: ContentEvent[] = [];
    for (const e of events) {
      if (e.type === "text") {
        out.push({ type: "text", data: { delta: e.text } });
      } else if (e.type === "chart") {
        const result = buildChartFromModelBlock(e.raw, this.analyticsResults);
        if (result.ok) {
          this.chartSeq += 1;
          out.push({ type: "chart", data: { id: `chart-${this.chartSeq}`, spec: result.spec } });
        } else {
          out.push({ type: "chart_dropped", data: { reason: result.reason } });
        }
      } else {
        out.push({ type: "chart_dropped", data: { reason: e.reason } });
      }
    }
    return out;
  }

  private finalizeToolResult(block: Extract<BlockState, { kind: "tool_result" }>): ContentEvent[] {
    const name = this.toolUseById.get(block.toolUseId);
    const rows = parseAnalyticsRows(block.textAccum);
    const isAnalytics = !!name && isAnalyticsTool(name);
    const valid = isAnalytics && !block.isError && rows != null;

    this.analyticsResults.push({
      toolUseId: block.toolUseId,
      toolName: name ?? "",
      rows: valid ? rows : null,
      valid,
    });

    const reason = valid
      ? undefined
      : block.isError
        ? "tool_error"
        : !isAnalytics
          ? "not_analytics"
          : "invalid_rows";

    return [
      {
        type: "tool_debug",
        data: {
          kind: "tool_result",
          name,
          toolUseId: block.toolUseId,
          isError: block.isError,
          rowCount: valid ? (rows as unknown[]).length : undefined,
          reason,
        },
      },
    ];
  }
}
