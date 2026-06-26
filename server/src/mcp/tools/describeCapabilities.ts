import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A static, honest manifest of what the T Rock AI demo can answer about — and, just as importantly,
 * what it CANNOT. The model is instructed to call this first when feasibility is unclear, so it
 * declines impossible questions instead of guessing or fabricating.
 *
 * Coverage figures come from the Dallas data inventory (the confirmed facts the demo is built on).
 */
export interface AnswerableDomain {
  domain: string;
  tool: string;
  description: string;
}

export interface CapabilitiesManifest {
  office: string;
  readOnly: true;
  numbersPolicy: string;
  answerable: AnswerableDomain[];
  coverageCaveats: string[];
  notAvailable: string[];
}

export function buildCapabilitiesManifest(): CapabilitiesManifest {
  return {
    office: "Dallas (single tenant — this demo cannot see any other office)",
    readOnly: true,
    numbersPolicy:
      "Every number is computed by a SQL tool. The assistant must never compute, estimate, or " +
      "infer a figure on its own — if no tool returns it, the number is not available.",
    answerable: [
      {
        domain: "Pipeline summary",
        tool: "get_pipeline_summary",
        description:
          "Counts and Won revenue for Won / Active / Stalled deals over a preset time window. " +
          "Stalled uses the existing at-risk rule (no new threshold).",
      },
      {
        domain: "Deal lists",
        tool: "list_deals",
        description:
          "Individual deals filtered by stage, owner, value, or date (limit 25, max 100).",
      },
      {
        domain: "Bid → award variance",
        tool: "get_bid_award_variance",
        description:
          "Per-rep variance between a deal's bid_estimate and its final awarded_amount on Won deals: " +
          "count, average & median variance %, variability, and dollar magnitude.",
      },
    ],
    coverageCaveats: [
      "Estimate variance is bid → award ONLY. dd_estimate is ~4% populated, so estimate-vs-actual " +
        "variance is NOT available.",
      "Only ~17% of emails are linked to a deal; any email coverage is partial.",
      "awarded_amount is populated on ~44% of deals; award-based figures cover that subset only.",
    ],
    notAvailable: [
      "Margin, cost, or profit — these are not in the data.",
      "Any office other than Dallas — this is a single-tenant demo.",
      "Forecasts or predictions — the tools report history, not projections.",
    ],
  };
}

export function registerDescribeCapabilities(server: McpServer): void {
  server.registerTool(
    "describe_capabilities",
    {
      title: "Describe capabilities",
      description:
        "Returns the data domains this assistant can answer about for the Dallas office, with " +
        "coverage caveats and an explicit list of what is NOT available. Call this FIRST whenever " +
        "it is unclear whether a question can be answered from the data.",
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(buildCapabilitiesManifest(), null, 2) }],
    })
  );
}
