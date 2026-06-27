import { describe, it, expect } from "vitest";
import { StreamProcessor, type AnthropicStreamEvent, type ContentEvent } from "./stream-processor.js";

const ROWS = [
  { segment: "Won", count: 3, value: 150999 },
  { segment: "Active", count: 5, value: 90000 },
];
const RESULT_TEXT = JSON.stringify({ preset: "ytd", rows: ROWS });

// --- event builders ---
const toolUse = (index: number, id: string, name: string): AnthropicStreamEvent => ({
  type: "content_block_start",
  index,
  content_block: { type: "mcp_tool_use", id, name, server_name: "trock-data" },
});
const toolResultStart = (index: number, toolUseId: string, text: string | null, isError = false): AnthropicStreamEvent => ({
  type: "content_block_start",
  index,
  content_block: { type: "mcp_tool_result", tool_use_id: toolUseId, is_error: isError, content: text == null ? [] : [{ type: "text", text }] },
});
const blockStop = (index: number): AnthropicStreamEvent => ({ type: "content_block_stop", index });
const textStart = (index: number): AnthropicStreamEvent => ({ type: "content_block_start", index, content_block: { type: "text" } });
const textDelta = (index: number, text: string): AnthropicStreamEvent => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const messageDelta = (stop: string): AnthropicStreamEvent => ({ type: "message_delta", delta: { stop_reason: stop } });

function feed(p: StreamProcessor, evts: AnthropicStreamEvent[]): ContentEvent[] {
  return evts.flatMap((e) => p.process(e));
}
const debug = (events: ContentEvent[]) => events.filter((e) => e.type === "tool_debug");

describe("StreamProcessor — analytics capture", () => {
  it("captures an analytics result delivered WHOLE at content_block_start", () => {
    const p = new StreamProcessor();
    const events = feed(p, [toolUse(0, "tu1", "get_pipeline_summary"), toolResultStart(1, "tu1", RESULT_TEXT), blockStop(1)]);
    expect(p.analyticsResults).toEqual([{ toolUseId: "tu1", toolName: "get_pipeline_summary", rows: ROWS, valid: true }]);
    const tr = debug(events).find((e) => e.data.kind === "tool_result");
    expect(tr?.data).toMatchObject({ kind: "tool_result", rowCount: 2, isError: false });
  });

  it("captures an analytics result delivered via deltas", () => {
    const p = new StreamProcessor();
    const half = Math.floor(RESULT_TEXT.length / 2);
    feed(p, [
      toolUse(0, "tu1", "list_deals"),
      toolResultStart(1, "tu1", null),
      textDelta(1, RESULT_TEXT.slice(0, half)),
      textDelta(1, RESULT_TEXT.slice(half)),
      blockStop(1),
    ]);
    expect(p.analyticsResults[0]).toMatchObject({ toolName: "list_deals", valid: true });
    expect(p.analyticsResults[0].rows).toEqual(ROWS);
  });

  it("marks a non-analytics tool result invalid (not chartable)", () => {
    const p = new StreamProcessor();
    const events = feed(p, [toolUse(0, "tu1", "describe_capabilities"), toolResultStart(1, "tu1", "{\"answerable\":[]}"), blockStop(1)]);
    expect(p.analyticsResults[0]).toMatchObject({ toolName: "describe_capabilities", rows: null, valid: false });
    expect(debug(events).find((e) => e.data.kind === "tool_result")?.data.reason).toBe("not_analytics");
  });

  it("marks an errored tool result invalid", () => {
    const p = new StreamProcessor();
    feed(p, [toolUse(0, "tu1", "get_pipeline_summary"), toolResultStart(1, "tu1", "boom", true), blockStop(1)]);
    expect(p.analyticsResults[0]).toMatchObject({ valid: false });
  });

  it("retains analytics state across a pause_turn (continuation feeds the same processor)", () => {
    const p = new StreamProcessor();
    feed(p, [toolUse(0, "tu1", "get_pipeline_summary"), toolResultStart(1, "tu1", RESULT_TEXT), blockStop(1), messageDelta("pause_turn")]);
    expect(p.stopReason).toBe("pause_turn");
    // continuation: another analytics call appends, state preserved
    feed(p, [toolUse(2, "tu2", "list_deals"), toolResultStart(3, "tu2", RESULT_TEXT), blockStop(3), messageDelta("end_turn")]);
    expect(p.analyticsResults.map((r) => r.toolUseId)).toEqual(["tu1", "tu2"]);
    expect(p.stopReason).toBe("end_turn");
  });
});

describe("StreamProcessor — text + chart seam", () => {
  it("resolves a trock-chart fence against a captured result, injecting verbatim rows", () => {
    const p = new StreamProcessor();
    feed(p, [toolUse(0, "tu1", "get_pipeline_summary"), toolResultStart(1, "tu1", RESULT_TEXT), blockStop(1), textStart(2)]);
    const chartJson = JSON.stringify({
      dataRef: { tool: "get_pipeline_summary" },
      spec: { mark: "bar", encoding: { x: { field: "segment" }, y: { field: "value" } } },
    });
    const events = feed(p, [textDelta(2, `Here:\n\`\`\`trock-chart\n${chartJson}\n\`\`\`\nthat's it`)]);
    const chart = events.find((e) => e.type === "chart");
    expect(chart).toBeDefined();
    if (chart?.type === "chart") {
      expect((chart.data.spec.data as { values: unknown }).values).toEqual(ROWS);
      expect(chart.data.id).toBe("chart-1");
    }
    // prose before the fence ("Here:\n") + prose after it ("\nthat's it"); the chart sat between.
    expect(events.filter((e) => e.type === "text").map((e) => (e as { data: { delta: string } }).data.delta).join("")).toBe(
      "Here:\n\nthat's it"
    );
  });

  it("drops a chart whose dataRef tool was never captured", () => {
    const p = new StreamProcessor();
    feed(p, [textStart(0)]);
    const chartJson = JSON.stringify({ dataRef: { tool: "get_pipeline_summary" }, spec: { mark: "bar", encoding: { x: { field: "segment" } } } });
    const events = feed(p, [textDelta(0, `\`\`\`trock-chart\n${chartJson}\n\`\`\``)]);
    expect(events.find((e) => e.type === "chart_dropped")?.type).toBe("chart_dropped");
    expect(events.some((e) => e.type === "chart")).toBe(false);
  });

  it("drops an unclosed fence at finish(), never as text", () => {
    const p = new StreamProcessor();
    feed(p, [textStart(0), textDelta(0, "answer ```trock-chart\n{\"dataRef\"")]);
    const tail = p.finish();
    expect(tail.some((e) => e.type === "chart_dropped" && e.data.reason === "unclosed_fence")).toBe(true);
  });
});

describe("StreamProcessor — ungrounded-prose backstop (no-tool fabrication only)", () => {
  const proseTurn = (text: string): StreamProcessor => {
    const p = new StreamProcessor();
    feed(p, [textStart(0), textDelta(0, text)]);
    return p;
  };
  const flagged = (events: ContentEvent[]) =>
    events.some((e) => e.type === "text" && /not grounded/.test((e as { data: { delta: string } }).data.delta));

  it("flags a money figure stated with no analytics tool grounding this turn", () => {
    expect(flagged(proseTurn("Won revenue was $1,250,000 this year.").finish())).toBe(true);
  });

  it("flags a thousands-grouped figure with no tool grounding", () => {
    expect(flagged(proseTurn("We have 1,234 open deals.").finish())).toBe(true);
  });

  it("does NOT flag when an analytics tool returned data this turn (prompt + chart seam own that path)", () => {
    const p = new StreamProcessor();
    feed(p, [
      toolUse(0, "tu1", "get_pipeline_summary"),
      toolResultStart(1, "tu1", RESULT_TEXT),
      blockStop(1),
      textStart(2),
      textDelta(2, "Won revenue was $1,250,000."),
    ]);
    expect(flagged(p.finish())).toBe(false);
  });

  it("does NOT flag years, percentages, ordinals, or small counts (false-positive guard)", () => {
    expect(
      flagged(proseTurn("In 2024 the top 3 reps closed about 60% of deals; the 1st was strongest.").finish())
    ).toBe(false);
  });

  it("does NOT flag a tool-less answer with no figures", () => {
    expect(flagged(proseTurn("I can summarize the pipeline once I call a data tool.").finish())).toBe(false);
  });
});
