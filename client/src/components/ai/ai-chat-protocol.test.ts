import { describe, it, expect } from "vitest";
import { parseSseBuffer, applyChatFrame, emptyTurn, type SseFrame } from "./ai-chat-protocol";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function reduce(frames: SseFrame[]) {
  return frames.reduce(applyChatFrame, emptyTurn());
}

describe("parseSseBuffer", () => {
  it("parses complete frames and carries a partial tail", () => {
    const buf = frame("meta", { turnId: "t1" }) + frame("text", { delta: "hi" }) + "event: text\ndata: {\"del";
    const { frames, rest } = parseSseBuffer(buf);
    expect(frames.map((f) => f.event)).toEqual(["meta", "text"]);
    expect(rest).toBe('event: text\ndata: {"del');
  });

  it("ignores comment/keepalive lines", () => {
    const { frames } = parseSseBuffer(":   keepalive\n\n" + frame("done", { stopReason: "end_turn" }));
    expect(frames.map((f) => f.event)).toEqual(["done"]);
  });
});

describe("applyChatFrame — ordered segment reduction", () => {
  it("interleaves text and chart segments in arrival order", () => {
    const state = reduce([
      { event: "meta", data: { turnId: "t1" } },
      { event: "text", data: { delta: "Pipeline " } },
      { event: "text", data: { delta: "looks strong." } },
      { event: "tool_debug", data: { kind: "tool_use", name: "get_pipeline_summary" } },
      { event: "chart", data: { id: "chart-1", spec: { mark: "bar" } } },
      { event: "text", data: { delta: "Questions?" } },
      { event: "done", data: { stopReason: "end_turn" } },
    ]);
    expect(state.turnId).toBe("t1");
    expect(state.segments).toEqual([
      { type: "text", text: "Pipeline looks strong." },
      { type: "chart", id: "chart-1", spec: { mark: "bar" } },
      { type: "text", text: "Questions?" },
    ]);
    expect(state.debug).toHaveLength(1);
    expect(state.done).toBe(true);
    expect(state.stopReason).toBe("end_turn");
  });

  it("SECURITY: an inline ```vega block in TEXT stays inert text — never a chart", () => {
    const state = reduce([
      { event: "text", data: { delta: "```vega\n{\"data\":{\"values\":[{\"x\":1,\"y\":2}]}}\n```" } },
    ]);
    expect(state.segments).toEqual([
      { type: "text", text: "```vega\n{\"data\":{\"values\":[{\"x\":1,\"y\":2}]}}\n```" },
    ]);
    expect(state.segments.some((s) => s.type === "chart")).toBe(false);
  });

  it("routes chart_dropped to debug, not the transcript", () => {
    const state = reduce([{ event: "chart_dropped", data: { reason: "numbers_in_spec" } }]);
    expect(state.segments).toHaveLength(0);
    expect(state.debug[0]).toMatchObject({ kind: "chart_dropped", detail: { reason: "numbers_in_spec" } });
  });

  it("ignores a malformed chart frame (missing id/spec)", () => {
    const state = reduce([{ event: "chart", data: { id: "x" } }]); // no spec
    expect(state.segments).toHaveLength(0);
  });

  it("captures an error", () => {
    const state = reduce([{ event: "error", data: { message: "boom" } }]);
    expect(state.error).toBe("boom");
  });
});
