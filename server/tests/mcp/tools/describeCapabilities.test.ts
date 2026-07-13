import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildCapabilitiesManifest,
  registerDescribeCapabilities,
} from "../../../src/mcp/tools/describeCapabilities.js";

describe("describe_capabilities manifest", () => {
  const m = buildCapabilitiesManifest();

  it("is Dallas-only and read-only", () => {
    expect(m.office.toLowerCase()).toContain("dallas");
    expect(m.readOnly).toBe(true);
  });

  it("states that SQL owns every number", () => {
    expect(m.numbersPolicy.toLowerCase()).toContain("sql");
    expect(m.numbersPolicy.toLowerCase()).toMatch(/never|not/);
  });

  it("advertises the planned answerable domains by tool name", () => {
    const tools = m.answerable.map((d) => d.tool);
    expect(tools).toContain("get_pipeline_summary");
    expect(tools).toContain("list_deals");
    expect(tools).toContain("get_bid_award_variance");
  });

  it("surfaces the coverage caveats from the inventory (dd_estimate, emails, awarded)", () => {
    const text = m.coverageCaveats.join(" ").toLowerCase();
    expect(text).toContain("dd_estimate");
    expect(text).toMatch(/4%/);
    expect(text).toMatch(/17%/);
    expect(text).toMatch(/44%/);
  });

  it("explicitly lists what is NOT available (margin/cost/profit, other offices, forecasts)", () => {
    const text = m.notAvailable.join(" ").toLowerCase();
    expect(text).toMatch(/margin|cost|profit/);
    expect(text).toMatch(/office|tenant|dallas/);
    expect(text).toMatch(/forecast|prediction/);
  });
});

describe("registerDescribeCapabilities", () => {
  it("registers a describe_capabilities tool whose handler returns the manifest as text", async () => {
    const registerTool = vi.fn();
    const fakeServer = { registerTool } as unknown as McpServer;

    registerDescribeCapabilities(fakeServer);

    expect(registerTool).toHaveBeenCalledOnce();
    const [name, config, cb] = registerTool.mock.calls[0];
    expect(name).toBe("describe_capabilities");
    expect(typeof config.description).toBe("string");

    const result = await cb({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.office.toLowerCase()).toContain("dallas");
    expect(parsed.answerable.length).toBeGreaterThanOrEqual(3);
  });
});
