import { isAnalyticsTool } from "../../mcp/tools/analyticsToolNames.js";

/**
 * THE chart seam — the single enforcement point that lets the demo render model-composed charts
 * while guaranteeing model-typed numbers NEVER reach a chart. See docs/specs/mcp-chart-seam.md.
 *
 * Three stacked, independently-sufficient guarantees:
 *   1. The model authors only a number-free skeleton; any numeric literal in its spec drops the chart.
 *   2. The spec is allowlist-REBUILT (not strip-in-place), so there is no structural slot for model
 *      data even before the number check.
 *   3. The final data.values is assigned EXCLUSIVELY from a verbatim, allowlisted analytics-tool
 *      result, and overwritten LAST.
 */

export type AnalyticsRow = Record<string, string | number | boolean | null>;

/** A tool result captured by the stream relay. `valid` ⟺ analytics tool, not is_error, rows parsed. */
export interface CapturedAnalyticsResult {
  toolUseId: string;
  toolName: string;
  rows: AnalyticsRow[] | null;
  valid: boolean;
}

export type ChartDropReason =
  | "parse_failed"
  | "numbers_in_spec"
  | "unresolved_dataRef"
  | "unknown_field";

export type BuildChartResult =
  | { ok: true; spec: Record<string, unknown> }
  | { ok: false; reason: ChartDropReason };

const MAX_ROWS = 1000;
const MAX_CELLS = 20_000;

/** Vega-Lite encoding-channel keys we copy — all string-typed, so numbers can't ride in via a channel. */
const ALLOWED_CHANNEL_KEYS = ["field", "type", "aggregate", "timeUnit", "sort", "title"] as const;

/** Server-owned spec constants (trusted, may contain numbers — added AFTER the number-free check). */
const CHART_CONFIG = { view: { stroke: null } } as const;
const VEGA_LITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json";

/**
 * Strict parser for an analytics tool's text result → verbatim rows, or null on any doubt.
 * Accepts a top-level array or `{rows:[...]}` / `{data:[...]}`; requires 1..1000 rows; every row a
 * plain object whose every value is string|number|boolean|null (no nesting); caps total cells. Rows
 * are kept verbatim — never coerced.
 */
export function parseAnalyticsRows(text: string): AnalyticsRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  let candidate: unknown;
  if (Array.isArray(parsed)) {
    candidate = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.rows)) candidate = obj.rows;
    else if (Array.isArray(obj.data)) candidate = obj.data;
    else return null;
  } else {
    return null;
  }

  const rows = candidate as unknown[];
  if (rows.length < 1 || rows.length > MAX_ROWS) return null;

  let cells = 0;
  const out: AnalyticsRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    const clean: AnalyticsRow = {};
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return null;
      }
      clean[key] = value as string | number | boolean | null;
      cells += 1;
      if (cells > MAX_CELLS) return null;
    }
    out.push(clean);
  }
  return out;
}

/** Recursively true iff `value` contains no number/bigint anywhere (field-name strings are fine). */
export function isNumberFree(value: unknown): boolean {
  if (typeof value === "number" || typeof value === "bigint") return false;
  if (Array.isArray(value)) return value.every(isNumberFree);
  if (value && typeof value === "object") return Object.values(value).every(isNumberFree);
  return true;
}

function rebuildMark(mark: unknown): string | null {
  if (typeof mark === "string") return mark;
  if (mark && typeof mark === "object" && !Array.isArray(mark)) {
    const type = (mark as Record<string, unknown>).type;
    if (typeof type === "string") return type;
  }
  return null;
}

function rebuildEncoding(encoding: unknown): Record<string, Record<string, string>> | null {
  if (!encoding || typeof encoding !== "object" || Array.isArray(encoding)) return null;
  const out: Record<string, Record<string, string>> = {};
  for (const [channel, def] of Object.entries(encoding as Record<string, unknown>)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    const source = def as Record<string, unknown>;
    const cleanChannel: Record<string, string> = {};
    for (const key of ALLOWED_CHANNEL_KEYS) {
      const val = source[key];
      // Only string-typed channel props survive — drops sort-objects, numeric value/scale, etc.
      if (typeof val === "string") cleanChannel[key] = val;
    }
    out[channel] = cleanChannel;
  }
  return out;
}

/**
 * The ONLY function permitted to return a renderable chart spec. Any failure ⇒ { ok:false, reason }
 * (the relay emits chart_dropped) — there is NEVER a fallback to model numbers.
 */
export function buildChartFromModelBlock(
  rawBlock: string,
  analyticsResults: CapturedAnalyticsResult[]
): BuildChartResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlock);
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "parse_failed" };
  }
  const block = parsed as Record<string, unknown>;
  const dataRef = block.dataRef;
  const spec = block.spec;
  if (!dataRef || typeof dataRef !== "object" || Array.isArray(dataRef)) {
    return { ok: false, reason: "parse_failed" };
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, reason: "parse_failed" };
  }

  // Guarantee 1: the model's spec must be entirely number-free (it authored a skeleton, not data).
  if (!isNumberFree(spec)) return { ok: false, reason: "numbers_in_spec" };

  // Guarantee 2: allowlist-REBUILD — only a closed set of string/enum fields survive; no data slot.
  const specObj = spec as Record<string, unknown>;
  const mark = rebuildMark(specObj.mark);
  const encoding = rebuildEncoding(specObj.encoding);
  if (!mark || !encoding) return { ok: false, reason: "parse_failed" };
  const rebuiltSpec: Record<string, unknown> = { mark, encoding };

  // Resolve dataRef → a real, allowlisted, valid captured analytics result.
  const ref = dataRef as Record<string, unknown>;
  const tool = ref.tool;
  if (typeof tool !== "string" || !isAnalyticsTool(tool)) {
    return { ok: false, reason: "unresolved_dataRef" };
  }
  const candidates = analyticsResults.filter((r) => r.toolName === tool && r.valid && r.rows);
  let resolved: CapturedAnalyticsResult;
  if (candidates.length === 0) {
    return { ok: false, reason: "unresolved_dataRef" };
  } else if (candidates.length === 1) {
    resolved = candidates[0];
  } else {
    // Ambiguous: require an explicit, in-range, matching global resultIndex — never guess.
    const idx = ref.resultIndex;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= analyticsResults.length) {
      return { ok: false, reason: "unresolved_dataRef" };
    }
    const entry = analyticsResults[idx];
    if (!entry || entry.toolName !== tool || !entry.valid || !entry.rows) {
      return { ok: false, reason: "unresolved_dataRef" };
    }
    resolved = entry;
  }
  const rows = resolved.rows as AnalyticsRow[];

  // Guarantee 3 (field existence): every referenced column must exist in the real rows — kills
  // invented columns.
  const firstRow = rows[0];
  for (const channel of Object.values(encoding)) {
    const field = channel.field;
    // OWN-property check (not `in`): a field like "toString"/"constructor" is inherited, not a real
    // column, and must NOT pass as a valid field.
    if (typeof field === "string" && !Object.hasOwn(firstRow, field)) {
      return { ok: false, reason: "unknown_field" };
    }
  }

  // data is overwritten LAST, so it can only ever be the verbatim, allowlisted tool rows.
  const finalSpec: Record<string, unknown> = {
    $schema: VEGA_LITE_SCHEMA,
    width: "container",
    height: 300,
    config: CHART_CONFIG,
    ...rebuiltSpec,
    data: { values: rows },
  };
  return { ok: true, spec: finalSpec };
}
