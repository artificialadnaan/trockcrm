import { describe, expect, it, vi } from "vitest";
import {
  estimateDealMarketOverrides,
  estimateMarketAdjustmentRules,
  estimateMarketFallbackGeographies,
  estimateMarketZipMappings,
  estimateMarkets,
} from "../../../../shared/src/schema/index.js";
import {
  createMarketRateProvider,
  getAllowedPricingScopeTypes,
  isPricingScopeBroadEnough,
} from "../../../src/modules/estimating/market-rate-provider.js";
import {
  calculateMarketRateAdjustment,
  selectBestMarketAdjustmentRule,
} from "../../../src/modules/estimating/market-rate-service.js";

function makeRule(input: Partial<Record<string, unknown>> & { id: string }) {
  return {
    id: input.id,
    marketId: (input.marketId ?? null) as string | null,
    scopeType: (input.scopeType ?? "general") as string,
    scopeKey: (input.scopeKey ?? "default") as string,
    fallbackScopeType: (input.fallbackScopeType ?? null) as string | null,
    fallbackScopeKey: (input.fallbackScopeKey ?? null) as string | null,
    priority: (input.priority ?? 0) as number,
    fallbackPriority: (input.fallbackPriority ?? 0) as number,
    laborAdjustmentPercent: (input.laborAdjustmentPercent ?? 0) as number | string,
    materialAdjustmentPercent: (input.materialAdjustmentPercent ?? 0) as number | string,
    equipmentAdjustmentPercent: (input.equipmentAdjustmentPercent ?? 0) as number | string,
    defaultLaborWeight: (input.defaultLaborWeight ?? 0.3333) as number | string,
    defaultMaterialWeight: (input.defaultMaterialWeight ?? 0.3333) as number | string,
    defaultEquipmentWeight: (input.defaultEquipmentWeight ?? 0.3334) as number | string,
    effectiveFrom: (input.effectiveFrom ?? new Date("2000-01-01T00:00:00Z")) as Date,
    effectiveTo: (input.effectiveTo ?? null) as Date | null,
    isActive: (input.isActive ?? true) as boolean,
  } as any;
}

const providerTables = {
  estimateDealMarketOverrides,
  estimateMarketAdjustmentRules,
  estimateMarketFallbackGeographies,
  estimateMarketZipMappings,
  estimateMarkets,
};

describe("market-rate-service", () => {
  it("exposes the pricing-scope helper hierarchy used by the provider filter", () => {
    expect(getAllowedPricingScopeTypes("division")).toEqual(["general", "division"]);
    expect(getAllowedPricingScopeTypes("trade")).toEqual(["general", "division", "trade"]);
    expect(isPricingScopeBroadEnough("general", "division")).toBe(true);
    expect(isPricingScopeBroadEnough("trade", "division")).toBe(false);
  });

  it("reaches the broad default pricing rule through the provider path", async () => {
    const tradeNarrowRule = makeRule({
      id: "trade-narrow",
      marketId: "market-1",
      scopeType: "trade",
      scopeKey: "roofing",
      fallbackScopeType: "general",
      fallbackScopeKey: "default",
      priority: 100,
    });
    const broadDefaultRule = makeRule({
      id: "broad-default",
      marketId: null,
      scopeType: "general",
      scopeKey: "default",
      priority: 0,
    });

    const provider = createMarketRateProvider(
      {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve([tradeNarrowRule, broadDefaultRule])),
          })),
        })),
      } as any,
      providerTables
    );

    const result = await selectBestMarketAdjustmentRule(provider, {
      marketId: "market-1",
      pricingScopeType: "division",
      pricingScopeKey: "07",
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result?.id).toBe("broad-default");
  });

  it("does not let a trade rule satisfy a division request through general/default fallback", async () => {
    const provider = {
      listMarketAdjustmentRules: vi.fn().mockResolvedValue([
        makeRule({
          id: "trade-narrow",
          marketId: "market-1",
          scopeType: "trade",
          scopeKey: "roofing",
          fallbackScopeType: "general",
          fallbackScopeKey: "default",
          priority: 100,
        }),
      ]),
    } as any;

    const result = await selectBestMarketAdjustmentRule(provider, {
      marketId: "market-1",
      pricingScopeType: "division",
      pricingScopeKey: "07",
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result).toBeNull();
  });

  it("does not let a trade rule satisfy a general request through general/default fallback", async () => {
    const provider = {
      listMarketAdjustmentRules: vi.fn().mockResolvedValue([
        makeRule({
          id: "trade-narrow",
          marketId: "market-1",
          scopeType: "trade",
          scopeKey: "roofing",
          fallbackScopeType: "general",
          fallbackScopeKey: "default",
          priority: 100,
        }),
      ]),
    } as any;

    const result = await selectBestMarketAdjustmentRule(provider, {
      marketId: "market-1",
      pricingScopeType: "general",
      pricingScopeKey: "default",
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result).toBeNull();
  });

  it("filters out expired rules before selecting the best match", async () => {
    const provider = {
      listMarketAdjustmentRules: vi.fn().mockResolvedValue([
        makeRule({
          id: "expired",
          marketId: "market-1",
          scopeType: "trade",
          scopeKey: "roofing",
          effectiveTo: new Date("2025-01-01T00:00:00Z"),
        }),
        makeRule({
          id: "active",
          marketId: "market-1",
          scopeType: "trade",
          scopeKey: "roofing",
          effectiveFrom: new Date("2020-01-01T00:00:00Z"),
        }),
      ]),
    } as any;

    const result = await selectBestMarketAdjustmentRule(provider, {
      marketId: "market-1",
      pricingScopeType: "trade",
      pricingScopeKey: "roofing",
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result?.id).toBe("active");
  });

  it("normalizes partial split weights so missing components do not overcount the baseline", async () => {
    const provider = {
      listMarketAdjustmentRules: vi.fn().mockResolvedValue([
        makeRule({
          id: "active",
          marketId: "market-1",
          scopeType: "division",
          scopeKey: "07",
          laborAdjustmentPercent: 0,
          materialAdjustmentPercent: 0,
          equipmentAdjustmentPercent: 0,
          defaultLaborWeight: 0.5,
          defaultMaterialWeight: 0.3,
          defaultEquipmentWeight: 0.2,
        }),
      ]),
    } as any;

    const result = await calculateMarketRateAdjustment(provider, {
      marketResolution: {
        market: {
          id: "market-1",
          name: "Texas Market",
          slug: "tx",
          type: "state",
          stateCode: "TX",
          regionId: null,
        },
        resolutionLevel: "state",
        resolutionSource: { type: "state", key: "TX", marketId: "market-1" },
        location: { zip: "76102", state: "TX", regionId: null },
      } as any,
      pricingScopeType: "division",
      pricingScopeKey: "07",
      baselinePrice: 100,
      componentBreakdown: {
        labor: 0.5,
      },
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result.componentAdjustments.map((component: any) => component.weight)).toEqual([
      0.5,
      0.3,
      0.2,
    ]);
    expect(result.componentAdjustments.reduce((sum, component) => sum + component.baselineAmount, 0)).toBeCloseTo(100, 2);
    expect(result.adjustedPrice).toBeCloseTo(100, 2);
  });

  it("applies labor, material, and equipment deltas separately", async () => {
    const provider = {
      listMarketAdjustmentRules: vi.fn().mockResolvedValue([
        makeRule({
          id: "active",
          marketId: "market-1",
          scopeType: "division",
          scopeKey: "07",
          laborAdjustmentPercent: 10,
          materialAdjustmentPercent: -20,
          equipmentAdjustmentPercent: 0,
          defaultLaborWeight: 0.5,
          defaultMaterialWeight: 0.3,
          defaultEquipmentWeight: 0.2,
        }),
      ]),
    } as any;

    const result = await calculateMarketRateAdjustment(provider, {
      marketResolution: {
        market: {
          id: "market-1",
          name: "Texas Market",
          slug: "tx",
          type: "state",
          stateCode: "TX",
          regionId: null,
        },
        resolutionLevel: "state",
        resolutionSource: { type: "state", key: "TX", marketId: "market-1" },
        location: { zip: "76102", state: "TX", regionId: null },
      } as any,
      pricingScopeType: "division",
      pricingScopeKey: "07",
      baselinePrice: 100,
      componentBreakdown: {
        labor: 0.5,
        material: 0.3,
        equipment: 0.2,
      },
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result.adjustedPrice).toBeCloseTo(99, 2);
    expect(result.componentAdjustments.map((component: any) => component.component)).toEqual([
      "labor",
      "material",
      "equipment",
    ]);
    expect(result.componentAdjustments[0].adjustmentPercent).toBe(10);
    expect(result.componentAdjustments[1].adjustmentPercent).toBe(-20);
    expect(result.componentAdjustments[2].adjustmentPercent).toBe(0);
  });

  it("uses default split weights when a row has no explicit component breakdown", async () => {
    const provider = {
      listMarketAdjustmentRules: vi.fn().mockResolvedValue([
        makeRule({
          id: "active",
          marketId: "market-1",
          scopeType: "general",
          scopeKey: "default",
          laborAdjustmentPercent: 0,
          materialAdjustmentPercent: 0,
          equipmentAdjustmentPercent: 0,
          defaultLaborWeight: 0.4,
          defaultMaterialWeight: 0.35,
          defaultEquipmentWeight: 0.25,
        }),
      ]),
    } as any;

    const result = await calculateMarketRateAdjustment(provider, {
      marketResolution: {
        market: {
          id: "market-1",
          name: "Default Market",
          slug: "default",
          type: "global",
          stateCode: null,
          regionId: null,
        },
        resolutionLevel: "global_default",
        resolutionSource: { type: "global", key: "default", marketId: "market-1" },
        location: { zip: null, state: null, regionId: null },
      } as any,
      pricingScopeType: "general",
      pricingScopeKey: "default",
      baselinePrice: 100,
      componentBreakdown: null,
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result.componentAdjustments.map((component: any) => component.weight)).toEqual([
      0.4,
      0.35,
      0.25,
    ]);
    expect(result.componentAdjustments.map((component: any) => component.baselineAmount)).toEqual([
      40,
      35,
      25,
    ]);
  });

  it("includes the resolved market, resolution level, baseline, and component adjustments in the rationale payload", async () => {
    const provider = {
      listMarketAdjustmentRules: vi.fn().mockResolvedValue([
        makeRule({
          id: "active",
          marketId: "market-1",
          scopeType: "division",
          scopeKey: "07",
          laborAdjustmentPercent: 5,
          materialAdjustmentPercent: 0,
          equipmentAdjustmentPercent: -5,
          defaultLaborWeight: 0.5,
          defaultMaterialWeight: 0.25,
          defaultEquipmentWeight: 0.25,
        }),
      ]),
    } as any;

    const result = await calculateMarketRateAdjustment(provider, {
      marketResolution: {
        market: {
          id: "market-1",
          name: "Texas Market",
          slug: "tx",
          type: "state",
          stateCode: "TX",
          regionId: null,
        },
        resolutionLevel: "state",
        resolutionSource: { type: "state", key: "TX", marketId: "market-1" },
        location: { zip: "76102", state: "TX", regionId: null },
      } as any,
      pricingScopeType: "division",
      pricingScopeKey: "07",
      baselinePrice: 120,
      componentBreakdown: null,
      asOf: new Date("2026-04-21T00:00:00Z"),
    });

    expect(result.rationale.resolvedMarket.id).toBe("market-1");
    expect(result.rationale.resolutionLevel).toBe("state");
    expect(result.rationale.baselinePrice).toBe(120);
    expect(result.rationale.componentAdjustments).toHaveLength(3);
  });
});
