import { describe, expect, it, vi } from "vitest";
import { resolveMarketContext } from "../../../src/modules/estimating/market-resolution-service.js";

function createMarket(id: string, type: "global" | "metro" | "state" | "region") {
  return {
    id,
    name: `${id} name`,
    slug: id,
    type,
    stateCode: type === "global" || type === "region" ? null : "TX",
    regionId: type === "region" ? "region-1" : null,
  };
}

function createProvider(overrides: Record<string, unknown> = {}) {
  return {
    findDealMarketOverride: vi.fn().mockResolvedValue(null),
    findMarketByZip: vi.fn().mockResolvedValue(null),
    findMarketByFallbackGeography: vi.fn().mockResolvedValue(null),
    getDefaultMarket: vi.fn().mockResolvedValue(createMarket("market-default", "global")),
    ...overrides,
  } as any;
}

describe("resolveMarketContext", () => {
  it("resolves a ZIP directly to a market", async () => {
    const provider = createProvider({
      findMarketByZip: vi.fn().mockResolvedValue(createMarket("market-zip", "metro")),
    });

    const result = await resolveMarketContext(provider, {
      dealId: "deal-1",
      dealZip: "76102",
      dealState: "TX",
    });

    expect(result.market.id).toBe("market-zip");
    expect(result.resolutionLevel).toBe("zip");
    expect(result.resolutionSource.type).toBe("zip");
    expect(provider.findMarketByFallbackGeography).not.toHaveBeenCalled();
  });

  it("resolves a ZIP to metro context before broader fallback", async () => {
    const provider = createProvider({
      findMarketByZip: vi.fn().mockResolvedValue(null),
      findMarketByFallbackGeography: vi.fn().mockImplementation(async (input: any) => {
        if (input.resolutionType === "metro") {
          return createMarket("market-metro", "metro");
        }
        if (input.resolutionType === "state") {
          return createMarket("market-state", "state");
        }
        return null;
      }),
    });

    const result = await resolveMarketContext(provider, {
      dealId: "deal-1",
      dealZip: "76102",
      dealState: "TX",
    });

    expect(result.market.id).toBe("market-metro");
    expect(result.resolutionLevel).toBe("metro");
    expect(result.resolutionSource.type).toBe("metro");
    expect(provider.findMarketByFallbackGeography).toHaveBeenCalledWith(
      expect.objectContaining({ resolutionType: "metro", resolutionKey: "76102" })
    );
  });

  it("falls back to state or region geography when no ZIP mapping exists", async () => {
    const provider = createProvider({
      findMarketByZip: vi.fn().mockResolvedValue(null),
      findMarketByFallbackGeography: vi.fn().mockImplementation(async (input: any) => {
        if (input.resolutionType === "state") {
          return createMarket("market-state", "state");
        }
        if (input.resolutionType === "region") {
          return createMarket("market-region", "region");
        }
        return null;
      }),
    });

    const result = await resolveMarketContext(provider, {
      dealId: "deal-1",
      dealZip: "76102",
      dealState: "TX",
      regionId: "region-1",
    });

    expect(result.market.id).toBe("market-state");
    expect(result.resolutionLevel).toBe("state");
    expect(result.resolutionSource.type).toBe("state");
  });

  it("falls back to region geography when deal region is present and ZIP/state are blank", async () => {
    const provider = createProvider({
      findMarketByZip: vi.fn().mockResolvedValue(null),
      findMarketByFallbackGeography: vi.fn().mockImplementation(async (input: any) => {
        if (input.resolutionType === "region") {
          return createMarket("market-region", "region");
        }
        return null;
      }),
    });

    const result = await resolveMarketContext(provider, {
      dealId: "deal-1",
      dealZip: null,
      dealState: null,
      dealRegionId: "region-1",
    });

    expect(provider.findMarketByFallbackGeography).toHaveBeenCalledWith(
      expect.objectContaining({ resolutionType: "region", resolutionKey: "region-1" })
    );
    expect(result.location.regionId).toBe("region-1");
    expect(result.market.id).toBe("market-region");
    expect(result.resolutionLevel).toBe("region");
  });

  it("uses the global default when no geographic rule matches", async () => {
    const provider = createProvider({
      findMarketByZip: vi.fn().mockResolvedValue(null),
      findMarketByFallbackGeography: vi.fn().mockResolvedValue(null),
    });

    const result = await resolveMarketContext(provider, {
      dealId: "deal-1",
      dealZip: "99999",
      dealState: "ZZ",
    });

    expect(result.market.id).toBe("market-default");
    expect(result.resolutionLevel).toBe("global_default");
    expect(result.resolutionSource.type).toBe("global");
  });

  it("lets a deal-level override win over auto-resolution", async () => {
    const provider = createProvider({
      findDealMarketOverride: vi.fn().mockResolvedValue(createMarket("market-override", "metro")),
      findMarketByZip: vi.fn().mockResolvedValue(createMarket("market-zip", "metro")),
    });

    const result = await resolveMarketContext(provider, {
      dealId: "deal-1",
      dealZip: "76102",
      dealState: "TX",
    });

    expect(result.market.id).toBe("market-override");
    expect(result.resolutionLevel).toBe("override");
    expect(result.resolutionSource.type).toBe("override");
  });

  it("falls back from deal geography to related property geography when deal fields are blank", async () => {
    const provider = createProvider({
      findMarketByZip: vi.fn().mockImplementation(async (zip: string) => {
        if (zip === "76102") {
          return createMarket("market-zip", "metro");
        }
        return null;
      }),
    });

    const result = await resolveMarketContext(provider, {
      dealId: "deal-1",
      dealZip: null,
      dealState: null,
      propertyZip: "76102",
      propertyState: "TX",
    });

    expect(provider.findMarketByZip).toHaveBeenCalledWith("76102");
    expect(result.location.zip).toBe("76102");
    expect(result.location.state).toBe("TX");
    expect(result.market.id).toBe("market-zip");
  });
});
