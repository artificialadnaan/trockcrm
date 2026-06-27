/**
 * DEFAULT-DENY allowlist of the analytics/SQL tools whose verbatim output may back a chart.
 *
 * SECURITY (chart seam, see docs/specs/mcp-chart-seam.md §9): this is the ONLY set of tool names a
 * chart's data may be sourced from. It is the single source of truth — the chart seam imports it
 * rather than hardcoding the names. `describe_capabilities` (a static manifest, not rows) and the
 * email tools (full client email bodies = PII) are deliberately EXCLUDED so they can never be
 * charted. A mis-set allowlist either drops every chart or, worse, could chart PII — so it is
 * pinned by a test.
 */
export const ANALYTICS_TOOL_NAMES = [
  "get_pipeline_summary",
  "list_deals",
  "get_bid_award_variance",
] as const;

export type AnalyticsToolName = (typeof ANALYTICS_TOOL_NAMES)[number];

export function isAnalyticsTool(name: string): boolean {
  return (ANALYTICS_TOOL_NAMES as readonly string[]).includes(name);
}
