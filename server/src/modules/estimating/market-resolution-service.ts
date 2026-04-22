import type { MarketIdentity, MarketRateProvider } from "./market-rate-provider.js";

export type MarketResolutionLevel = "override" | "zip" | "metro" | "state" | "region" | "global_default";

export interface DealMarketLocationInput {
  dealZip?: string | null;
  dealState?: string | null;
  dealRegionId?: string | null;
  propertyZip?: string | null;
  propertyState?: string | null;
  propertyRegionId?: string | null;
}

export interface ResolvedMarketContext {
  market: MarketIdentity;
  resolutionLevel: MarketResolutionLevel;
  resolutionSource: {
    type: "override" | "zip" | "metro" | "state" | "region" | "global";
    key: string | null;
    marketId: string;
  };
  location: {
    zip: string | null;
    state: string | null;
    regionId: string | null;
  };
}

function normalizeZip(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeState(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.toUpperCase() : null;
}

function normalizeRegionId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveDealMarketLocation(input: DealMarketLocationInput) {
  return {
    zip: normalizeZip(input.dealZip) ?? normalizeZip(input.propertyZip),
    state: normalizeState(input.dealState) ?? normalizeState(input.propertyState),
    regionId: normalizeRegionId(input.dealRegionId) ?? normalizeRegionId(input.propertyRegionId),
  };
}

function buildResolutionResult(
  market: MarketIdentity,
  resolutionLevel: MarketResolutionLevel,
  resolutionSource: ResolvedMarketContext["resolutionSource"],
  location: ResolvedMarketContext["location"]
): ResolvedMarketContext {
  return {
    market,
    resolutionLevel,
    resolutionSource,
    location,
  };
}

export async function resolveMarketContext(
  provider: MarketRateProvider,
  input: DealMarketLocationInput & { dealId?: string | null }
): Promise<ResolvedMarketContext> {
  const location = resolveDealMarketLocation(input);

  if (input.dealId) {
    const overrideMarket = await provider.findDealMarketOverride(input.dealId);
    if (overrideMarket) {
      return buildResolutionResult(
        overrideMarket,
        "override",
        {
          type: "override",
          key: input.dealId,
          marketId: overrideMarket.id,
        },
        location
      );
    }
  }

  if (location.zip) {
    const directZipMarket = await provider.findMarketByZip(location.zip);
    if (directZipMarket) {
      return buildResolutionResult(
        directZipMarket,
        "zip",
        {
          type: "zip",
          key: location.zip,
          marketId: directZipMarket.id,
        },
        location
      );
    }

    const metroMarket = await provider.findMarketByFallbackGeography({
      resolutionType: "metro",
      resolutionKey: location.zip,
    });
    if (metroMarket) {
      return buildResolutionResult(
        metroMarket,
        "metro",
        {
          type: "metro",
          key: location.zip,
          marketId: metroMarket.id,
        },
        location
      );
    }
  }

  if (location.state) {
    const stateMarket = await provider.findMarketByFallbackGeography({
      resolutionType: "state",
      resolutionKey: location.state,
    });
    if (stateMarket) {
      return buildResolutionResult(
        stateMarket,
        "state",
        {
          type: "state",
          key: location.state,
          marketId: stateMarket.id,
        },
        location
      );
    }
  }

  if (location.regionId) {
    const regionMarket = await provider.findMarketByFallbackGeography({
      resolutionType: "region",
      resolutionKey: location.regionId,
    });
    if (regionMarket) {
      return buildResolutionResult(
        regionMarket,
        "region",
        {
          type: "region",
          key: location.regionId,
          marketId: regionMarket.id,
        },
        location
      );
    }
  }

  const defaultMarket = await provider.getDefaultMarket();
  if (!defaultMarket) {
    throw new Error("No default estimating market is configured");
  }

  return buildResolutionResult(
    defaultMarket,
    "global_default",
    {
      type: "global",
      key: "default",
      marketId: defaultMarket.id,
    },
    location
  );
}
