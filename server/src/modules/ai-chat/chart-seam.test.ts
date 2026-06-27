import { describe, it, expect } from "vitest";
import {
  parseAnalyticsRows,
  isNumberFree,
  buildChartFromModelBlock,
  type CapturedAnalyticsResult,
} from "./chart-seam.js";

const pipelineRows = [
  { segment: "Won", count: 3, value: 150999 },
  { segment: "Active", count: 5, value: 90000 },
  { segment: "Stalled", count: 2, value: 60000 },
];
function captured(over: Partial<CapturedAnalyticsResult> = {}): CapturedAnalyticsResult {
  return { toolUseId: "tu-1", toolName: "get_pipeline_summary", rows: pipelineRows, valid: true, ...over };
}
const block = (o: unknown) => JSON.stringify(o);

describe("parseAnalyticsRows", () => {
  it("accepts a top-level array, {rows:[...]}, and {data:[...]}", () => {
    expect(parseAnalyticsRows(JSON.stringify([{ a: 1 }]))).toEqual([{ a: 1 }]);
    expect(parseAnalyticsRows(JSON.stringify({ rows: [{ a: "x" }] }))).toEqual([{ a: "x" }]);
    expect(parseAnalyticsRows(JSON.stringify({ data: [{ a: true }] }))).toEqual([{ a: true }]);
  });
  it("rejects non-JSON, non-array shapes, empty, nested-object rows, and oversized inputs", () => {
    expect(parseAnalyticsRows("not json")).toBeNull();
    expect(parseAnalyticsRows(JSON.stringify({ nope: 1 }))).toBeNull();
    expect(parseAnalyticsRows(JSON.stringify([]))).toBeNull();
    expect(parseAnalyticsRows(JSON.stringify([{ nested: { a: 1 } }]))).toBeNull();
    expect(parseAnalyticsRows(JSON.stringify([{ arr: [1, 2] }]))).toBeNull();
    expect(parseAnalyticsRows(JSON.stringify(Array.from({ length: 1001 }, () => ({ a: 1 }))))).toBeNull();
  });
  it("keeps rows verbatim (no coercion)", () => {
    const rows = [{ n: 1, s: "x", b: false, z: null }];
    expect(parseAnalyticsRows(JSON.stringify(rows))).toEqual(rows);
  });
});

describe("isNumberFree", () => {
  it("passes string-only structures (field names ok) and fails on any number/bigint", () => {
    expect(isNumberFree({ field: "fy2024_total", type: "quantitative" })).toBe(true);
    expect(isNumberFree({ scale: { domain: [0, 100] } })).toBe(false);
    expect(isNumberFree({ value: 0 })).toBe(false);
    expect(isNumberFree([{ a: "x" }, { b: 1 }])).toBe(false);
  });
});

describe("buildChartFromModelBlock — the invariant", () => {
  it("happy path: data.values is the verbatim captured rows", () => {
    const res = buildChartFromModelBlock(
      block({
        dataRef: { tool: "get_pipeline_summary" },
        spec: { mark: "bar", encoding: { x: { field: "segment", type: "nominal" }, y: { field: "value", type: "quantitative", title: "Pipeline value" } } },
      }),
      [captured()]
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.spec.data as { values: unknown }).values).toEqual(pipelineRows);
    expect(res.spec.mark).toBe("bar");
  });

  it("drops a spec containing a numeric literal anywhere (numbers_in_spec)", () => {
    const res = buildChartFromModelBlock(
      block({
        dataRef: { tool: "get_pipeline_summary" },
        spec: { mark: "bar", encoding: { y: { field: "value", type: "quantitative", scale: { domain: [0, 200000] } } } },
      }),
      [captured()]
    );
    expect(res).toEqual({ ok: false, reason: "numbers_in_spec" });
  });

  it("model-supplied data.values full of numbers never reaches output (drop)", () => {
    const res = buildChartFromModelBlock(
      block({
        dataRef: { tool: "get_pipeline_summary" },
        spec: { mark: "bar", data: { values: [{ x: 1, y: 2 }] }, encoding: { x: { field: "segment" }, y: { field: "value" } } },
      }),
      [captured()]
    );
    expect(res).toEqual({ ok: false, reason: "numbers_in_spec" });
  });

  it("drops when dataRef.tool is not a captured analytics result (unresolved_dataRef)", () => {
    const res = buildChartFromModelBlock(
      block({ dataRef: { tool: "list_deals" }, spec: { mark: "bar", encoding: { x: { field: "segment" } } } }),
      [captured()] // only get_pipeline_summary captured
    );
    expect(res).toEqual({ ok: false, reason: "unresolved_dataRef" });
  });

  it("drops when the captured result is invalid", () => {
    const res = buildChartFromModelBlock(
      block({ dataRef: { tool: "get_pipeline_summary" }, spec: { mark: "bar", encoding: { x: { field: "segment" } } } }),
      [captured({ valid: false })]
    );
    expect(res).toEqual({ ok: false, reason: "unresolved_dataRef" });
  });

  it("drops when dataRef points at a non-analytics (email) tool — PII can never be charted", () => {
    const res = buildChartFromModelBlock(
      block({ dataRef: { tool: "get_email_thread" }, spec: { mark: "bar", encoding: { x: { field: "segment" } } } }),
      [{ toolUseId: "e1", toolName: "get_email_thread", rows: [{ segment: "x" }], valid: true }]
    );
    expect(res).toEqual({ ok: false, reason: "unresolved_dataRef" });
  });

  it("drops when an encoding field is not a real column (unknown_field)", () => {
    const res = buildChartFromModelBlock(
      block({ dataRef: { tool: "get_pipeline_summary" }, spec: { mark: "bar", encoding: { x: { field: "made_up_column" } } } }),
      [captured()]
    );
    expect(res).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("rejects an inherited-property field name like 'toString' (own-property check, not `in`)", () => {
    const res = buildChartFromModelBlock(
      block({ dataRef: { tool: "get_pipeline_summary" }, spec: { mark: "bar", encoding: { x: { field: "toString" } } } }),
      [captured()]
    );
    expect(res).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("multi-result: requires a valid resultIndex; uses the indexed dataset", () => {
    const a = captured({ toolUseId: "a", rows: [{ segment: "Won", value: 1 }] });
    const b = captured({ toolUseId: "b", rows: [{ segment: "Active", value: 2 }] });
    const spec = { mark: "bar", encoding: { x: { field: "segment" }, y: { field: "value" } } };

    expect(buildChartFromModelBlock(block({ dataRef: { tool: "get_pipeline_summary" }, spec }), [a, b])).toEqual({
      ok: false,
      reason: "unresolved_dataRef",
    });
    const res = buildChartFromModelBlock(block({ dataRef: { tool: "get_pipeline_summary", resultIndex: 1 }, spec }), [a, b]);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.spec.data as { values: unknown }).values).toEqual(b.rows);
  });

  it("multi-result: resultIndex counts ANALYTICS results only, skipping non-analytics/invalid entries", () => {
    // describe_capabilities (not analytics) is captured first and pushed as invalid; the model's
    // resultIndex is 0-based among ANALYTICS results, so resultIndex:1 must resolve to the SECOND
    // valid pipeline result — not full-array index 1 (which is the first pipeline result).
    const cap: CapturedAnalyticsResult = { toolUseId: "cap", toolName: "describe_capabilities", rows: null, valid: false };
    const p1 = captured({ toolUseId: "p1", rows: [{ segment: "Won", value: 1 }] });
    const p2 = captured({ toolUseId: "p2", rows: [{ segment: "Active", value: 2 }] });
    const spec = { mark: "bar", encoding: { x: { field: "segment" }, y: { field: "value" } } };

    const res = buildChartFromModelBlock(
      block({ dataRef: { tool: "get_pipeline_summary", resultIndex: 1 }, spec }),
      [cap, p1, p2]
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.spec.data as { values: unknown }).values).toEqual(p2.rows);
  });

  it("drops a digit-bearing channel title (model number as a string) but keeps a clean title", () => {
    const withDigits = buildChartFromModelBlock(
      block({
        dataRef: { tool: "get_pipeline_summary" },
        spec: { mark: "bar", encoding: { x: { field: "segment" }, y: { field: "value", title: "Won revenue: $123,456" } } },
      }),
      [captured()]
    );
    expect(withDigits.ok).toBe(true);
    if (!withDigits.ok) return;
    // chart still renders, but the model-authored numeric title never reaches the surface
    expect((withDigits.spec.encoding as Record<string, Record<string, unknown>>).y).not.toHaveProperty("title");

    const clean = buildChartFromModelBlock(
      block({
        dataRef: { tool: "get_pipeline_summary" },
        spec: { mark: "bar", encoding: { x: { field: "segment" }, y: { field: "value", title: "Won revenue" } } },
      }),
      [captured()]
    );
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect((clean.spec.encoding as Record<string, Record<string, unknown>>).y.title).toBe("Won revenue");
    }
  });

  it("allowlist-rebuild strips transform / params / layer / datasets from output", () => {
    const res = buildChartFromModelBlock(
      block({
        dataRef: { tool: "get_pipeline_summary" },
        spec: {
          mark: "bar",
          encoding: { x: { field: "segment", sort: { field: "value" } } }, // sort-object dropped (non-string)
          params: [{ name: "sel" }],
          layer: [],
          datasets: { foo: [] },
        },
      }),
      [captured()]
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.spec).not.toHaveProperty("params");
    expect(res.spec).not.toHaveProperty("layer");
    expect(res.spec).not.toHaveProperty("datasets");
    expect(res.spec).not.toHaveProperty("transform");
    // the sort object was non-string → dropped from the channel
    expect((res.spec.encoding as Record<string, Record<string, unknown>>).x).not.toHaveProperty("sort");
  });

  it("drops malformed blocks (parse_failed)", () => {
    expect(buildChartFromModelBlock("{not json", [captured()])).toEqual({ ok: false, reason: "parse_failed" });
    expect(buildChartFromModelBlock(block({ spec: { mark: "bar" } }), [captured()])).toEqual({ ok: false, reason: "parse_failed" }); // no dataRef
    expect(buildChartFromModelBlock(block({ dataRef: { tool: "get_pipeline_summary" } }), [captured()])).toEqual({ ok: false, reason: "parse_failed" }); // no spec
  });
});
