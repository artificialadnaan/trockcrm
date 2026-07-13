import { describe, it, expect } from "vitest";
import { FenceSplitter, type FenceEvent } from "./fence-splitter.js";

const CHART_JSON = '{"dataRef":{"tool":"get_pipeline_summary"},"spec":{"mark":"bar","encoding":{"x":{"field":"segment"}}}}';

/** Feed deltas, then end(); return all events in order. */
function run(deltas: string[]): FenceEvent[] {
  const fs = new FenceSplitter();
  const events: FenceEvent[] = [];
  for (const d of deltas) events.push(...fs.push(d));
  events.push(...fs.end());
  return events;
}
const textOf = (events: FenceEvent[]) =>
  events.filter((e): e is { type: "text"; text: string } => e.type === "text").map((e) => e.text).join("");
const charts = (events: FenceEvent[]) => events.filter((e): e is { type: "chart"; raw: string } => e.type === "chart");

describe("FenceSplitter", () => {
  it("emits plain prose as text, with no chart events", () => {
    const events = run(["Hello, here is your answer."]);
    expect(textOf(events)).toBe("Hello, here is your answer.");
    expect(charts(events)).toHaveLength(0);
  });

  it("extracts a whole chart block, emitting prose before and after as text", () => {
    const events = run([`Pipeline:\n\`\`\`trock-chart\n${CHART_JSON}\n\`\`\`\nDone.`]);
    expect(textOf(events)).toBe("Pipeline:\n\nDone.");
    const c = charts(events);
    expect(c).toHaveLength(1);
    expect(JSON.parse(c[0].raw.trim())).toEqual(JSON.parse(CHART_JSON));
  });

  it("withholds a sentinel split across deltas — no partial fence leaks to prose", () => {
    // The opening fence is split: "...```troc" then "k-chart..."
    const events = run(["Here ```troc", `k-chart\n${CHART_JSON}\n\`\`\`after`]);
    const text = textOf(events);
    expect(text).toBe("Here after");
    expect(text).not.toContain("```"); // the partial sentinel never reached the transcript
    expect(JSON.parse(charts(events)[0].raw.trim())).toEqual(JSON.parse(CHART_JSON));
  });

  it("does NOT mistake backticked prose (```json) for a chart", () => {
    const src = "Use ```json\nconst x = 1;\n``` in your code.";
    const events = run([src]);
    expect(textOf(events)).toBe(src); // emitted verbatim as text
    expect(charts(events)).toHaveLength(0);
  });

  it("drops an unclosed chart fence at end — never emitted as text", () => {
    const events = run(["text before ```trock-chart\n{\"dataRef\":{\"tool\":\"x\""]);
    expect(textOf(events)).toBe("text before ");
    expect(textOf(events)).not.toContain("dataRef");
    expect(events.some((e) => e.type === "chart_dropped")).toBe(true);
    expect(charts(events)).toHaveLength(0);
  });

  it("flushes a withheld partial sentinel that never completes as text at end", () => {
    const events = run(["all done ```troc"]);
    expect(textOf(events)).toBe("all done ```troc");
    expect(charts(events)).toHaveLength(0);
  });

  it("handles the chart JSON arriving across several deltas", () => {
    const half = Math.floor(CHART_JSON.length / 2);
    const events = run(["```trock-chart\n", CHART_JSON.slice(0, half), CHART_JSON.slice(half), "\n```"]);
    expect(JSON.parse(charts(events)[0].raw.trim())).toEqual(JSON.parse(CHART_JSON));
    expect(textOf(events)).toBe("");
  });
});
