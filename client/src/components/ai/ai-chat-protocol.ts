/**
 * Pure client-side protocol for the T Rock AI chat SSE stream (chart-seam spec §8).
 *
 * SECURITY (guarantee #1 — channel separation): charts are produced ONLY from validated `chart`
 * events here; `text` deltas only ever append to text segments. The renderer shows text segments as
 * prose/markdown and NEVER parses them for charts — so an inline ```vega block a model might type in
 * prose renders as inert text and can never reach the chart renderer.
 */

export type ChatSegment =
  | { type: "text"; text: string }
  | { type: "chart"; id: string; spec: unknown };

export interface DebugEvent {
  kind: string;
  detail: Record<string, unknown>;
}

export interface ChatTurnState {
  turnId?: string;
  segments: ChatSegment[];
  debug: DebugEvent[];
  done: boolean;
  stopReason?: string | null;
  error?: string;
}

export interface SseFrame {
  event: string;
  data: unknown;
}

export function emptyTurn(): ChatTurnState {
  return { segments: [], debug: [], done: false };
}

/**
 * Parse as many complete SSE frames as are present in `buffer`; return them plus the unconsumed tail
 * (a partial frame to carry into the next chunk).
 */
export function parseSseBuffer(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const sep = rest.indexOf("\n\n");
    if (sep < 0) break;
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    let event = "message";
    const dataParts: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataParts.push(line.slice("data:".length).trim());
      // lines starting with ":" are comments (e.g. keepalive/padding) — ignored
    }
    if (dataParts.length === 0) continue;
    try {
      frames.push({ event, data: JSON.parse(dataParts.join("")) });
    } catch {
      // skip a frame whose data isn't valid JSON
    }
  }
  return { frames, rest };
}

/** Apply one parsed frame to the turn state, returning a new state (ordered segment reduction). */
export function applyChatFrame(state: ChatTurnState, frame: SseFrame): ChatTurnState {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  switch (frame.event) {
    case "meta":
      return { ...state, turnId: typeof data.turnId === "string" ? data.turnId : state.turnId };
    case "text": {
      const delta = typeof data.delta === "string" ? data.delta : "";
      if (!delta) return state;
      const segments = [...state.segments];
      const last = segments[segments.length - 1];
      if (last && last.type === "text") {
        segments[segments.length - 1] = { type: "text", text: last.text + delta };
      } else {
        segments.push({ type: "text", text: delta });
      }
      return { ...state, segments };
    }
    case "chart": {
      // The ONLY way a chart segment is ever created — never from parsing text.
      if (typeof data.id !== "string" || data.spec == null) return state;
      return { ...state, segments: [...state.segments, { type: "chart", id: data.id, spec: data.spec }] };
    }
    case "tool_debug":
      return { ...state, debug: [...state.debug, { kind: "tool", detail: data }] };
    case "chart_dropped":
      return { ...state, debug: [...state.debug, { kind: "chart_dropped", detail: data }] };
    case "error":
      return { ...state, error: typeof data.message === "string" ? data.message : "stream error" };
    case "done":
      return { ...state, done: true, stopReason: (data.stopReason as string | null | undefined) ?? null };
    default:
      return state;
  }
}
