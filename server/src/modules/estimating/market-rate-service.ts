import type {
  MarketAdjustmentRuleRecord,
  MarketRateProvider,
  PricingScopeType,
} from "./market-rate-provider.js";
import type { ResolvedMarketContext } from "./market-resolution-service.js";

export interface MarketAdjustmentSelectionInput {
  marketId: string | null;
  pricingScopeType: PricingScopeType;
  pricingScopeKey: string;
  asOf?: Date;
}

export interface MarketComponentBreakdown {
  labor?: number | null;
  material?: number | null;
  equipment?: number | null;
}

export interface MarketRateAdjustmentInput {
  marketResolution: ResolvedMarketContext;
  pricingScopeType: PricingScopeType;
  pricingScopeKey: string;
  baselinePrice: number;
  componentBreakdown?: MarketComponentBreakdown | null;
  asOf?: Date;
}

export interface MarketComponentAdjustment {
  component: "labor" | "material" | "equipment";
  weight: number;
  baselineAmount: number;
  adjustmentPercent: number;
  adjustmentAmount: number;
  adjustedAmount: number;
}

export interface MarketRateAdjustmentResult {
  market: ResolvedMarketContext["market"];
  resolutionLevel: ResolvedMarketContext["resolutionLevel"];
  resolutionSource: ResolvedMarketContext["resolutionSource"];
  baselinePrice: number;
  selectedRule: MarketAdjustmentRuleRecord | null;
  componentAdjustments: MarketComponentAdjustment[];
  adjustedPrice: number;
  rationale: {
    resolvedMarket: ResolvedMarketContext["market"];
    resolutionLevel: ResolvedMarketContext["resolutionLevel"];
    resolutionSource: ResolvedMarketContext["resolutionSource"];
    baselinePrice: number;
    selectedRuleId: string | null;
    componentAdjustments: MarketComponentAdjustment[];
  };
}

function toNumber(value: number | string | null | undefined, fallback = 0) {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

function isRuleActiveAt(rule: MarketAdjustmentRuleRecord, asOf: Date) {
  const effectiveFrom = new Date(rule.effectiveFrom);
  const effectiveTo = rule.effectiveTo ? new Date(rule.effectiveTo) : null;
  return effectiveFrom <= asOf && (effectiveTo == null || effectiveTo >= asOf);
}

function isGeneralDefaultScope(rule: MarketAdjustmentRuleRecord) {
  return rule.scopeType === "general" && rule.scopeKey === "default";
}

function isMatchingPricingScope(
  rule: MarketAdjustmentRuleRecord,
  pricingScopeType: MarketAdjustmentSelectionInput["pricingScopeType"],
  pricingScopeKey: string
) {
  return rule.scopeType === pricingScopeType && rule.scopeKey === pricingScopeKey;
}

function isMatchingFallbackPricingScope(
  rule: MarketAdjustmentRuleRecord,
  pricingScopeType: MarketAdjustmentSelectionInput["pricingScopeType"],
  pricingScopeKey: string
) {
  return (
    rule.fallbackScopeType === pricingScopeType && rule.fallbackScopeKey === pricingScopeKey
  );
}

function getRuleTier(
  rule: MarketAdjustmentRuleRecord,
  marketId: string | null,
  pricingScopeType: MarketAdjustmentSelectionInput["pricingScopeType"],
  pricingScopeKey: string
) {
  const exactScope = isMatchingPricingScope(rule, pricingScopeType, pricingScopeKey);
  const fallbackScope = isMatchingFallbackPricingScope(rule, pricingScopeType, pricingScopeKey);
  const generalDefault = isGeneralDefaultScope(rule);
  const marketSpecific = marketId != null && rule.marketId === marketId;
  const globalRule = rule.marketId == null;

  if (marketSpecific && exactScope) return 0;
  if (marketSpecific && fallbackScope) return 1;
  if (marketSpecific && generalDefault) return 2;
  if (globalRule && exactScope) return 3;
  if (globalRule && fallbackScope) return 4;
  if (globalRule && generalDefault) return 5;
  return 6;
}

function compareRules(
  a: MarketAdjustmentRuleRecord,
  b: MarketAdjustmentRuleRecord,
  marketId: string | null,
  pricingScopeType: MarketAdjustmentSelectionInput["pricingScopeType"],
  pricingScopeKey: string
) {
  const tierDelta =
    getRuleTier(a, marketId, pricingScopeType, pricingScopeKey) -
    getRuleTier(b, marketId, pricingScopeType, pricingScopeKey);
  if (tierDelta !== 0) return tierDelta;

  const priorityDelta = toNumber(b.priority) - toNumber(a.priority);
  if (priorityDelta !== 0) return priorityDelta;

  const fallbackPriorityDelta = toNumber(b.fallbackPriority) - toNumber(a.fallbackPriority);
  if (fallbackPriorityDelta !== 0) return fallbackPriorityDelta;

  const effectiveFromDelta =
    new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime();
  if (effectiveFromDelta !== 0) return effectiveFromDelta;

  return a.id.localeCompare(b.id);
}

function normalizeWeights(
  rule: MarketAdjustmentRuleRecord | null,
  componentBreakdown: MarketComponentBreakdown | null | undefined
) {
  const fallbackLaborWeight = rule ? toNumber(rule.defaultLaborWeight) : 0.3333;
  const fallbackMaterialWeight = rule ? toNumber(rule.defaultMaterialWeight) : 0.3333;
  const fallbackEquipmentWeight = rule ? toNumber(rule.defaultEquipmentWeight) : 0.3334;

  const weights = {
    labor: componentBreakdown?.labor != null ? toNumber(componentBreakdown.labor) : fallbackLaborWeight,
    material:
      componentBreakdown?.material != null ? toNumber(componentBreakdown.material) : fallbackMaterialWeight,
    equipment:
      componentBreakdown?.equipment != null ? toNumber(componentBreakdown.equipment) : fallbackEquipmentWeight,
  };
  const total = weights.labor + weights.material + weights.equipment;

  if (total <= 0) {
    return {
      labor: fallbackLaborWeight,
      material: fallbackMaterialWeight,
      equipment: fallbackEquipmentWeight,
    };
  }

  return {
    labor: weights.labor / total,
    material: weights.material / total,
    equipment: weights.equipment / total,
  };
}

function buildComponentAdjustments(rule: MarketAdjustmentRuleRecord | null, baselinePrice: number, weights: {
  labor: number;
  material: number;
  equipment: number;
}) {
  const laborAdjustmentPercent = toNumber(rule?.laborAdjustmentPercent);
  const materialAdjustmentPercent = toNumber(rule?.materialAdjustmentPercent);
  const equipmentAdjustmentPercent = toNumber(rule?.equipmentAdjustmentPercent);

  const components: MarketComponentAdjustment[] = [
    {
      component: "labor",
      weight: weights.labor,
      baselineAmount: roundCurrency(baselinePrice * weights.labor),
      adjustmentPercent: laborAdjustmentPercent,
      adjustmentAmount: 0,
      adjustedAmount: 0,
    },
    {
      component: "material",
      weight: weights.material,
      baselineAmount: roundCurrency(baselinePrice * weights.material),
      adjustmentPercent: materialAdjustmentPercent,
      adjustmentAmount: 0,
      adjustedAmount: 0,
    },
    {
      component: "equipment",
      weight: weights.equipment,
      baselineAmount: roundCurrency(baselinePrice * weights.equipment),
      adjustmentPercent: equipmentAdjustmentPercent,
      adjustmentAmount: 0,
      adjustedAmount: 0,
    },
  ];

  return components.map((component) => {
    const adjustedAmount = roundCurrency(component.baselineAmount * (1 + component.adjustmentPercent / 100));
    return {
      ...component,
      adjustmentAmount: roundCurrency(adjustedAmount - component.baselineAmount),
      adjustedAmount,
    };
  });
}

export async function selectBestMarketAdjustmentRule(
  provider: MarketRateProvider,
  input: MarketAdjustmentSelectionInput
) {
  const asOf = input.asOf ?? new Date();
  const rules = await provider.listMarketAdjustmentRules({
    marketId: input.marketId,
    pricingScopeType: input.pricingScopeType,
    pricingScopeKey: input.pricingScopeKey,
    asOf,
  });

  return [...rules]
    .filter(
      (rule) =>
        rule.isActive &&
        isRuleActiveAt(rule, asOf) &&
        (isMatchingPricingScope(rule, input.pricingScopeType, input.pricingScopeKey) ||
          isMatchingFallbackPricingScope(rule, input.pricingScopeType, input.pricingScopeKey) ||
          isGeneralDefaultScope(rule) ||
          (rule.fallbackScopeType === "general" && rule.fallbackScopeKey === "default"))
    )
    .sort((a, b) =>
      compareRules(a, b, input.marketId, input.pricingScopeType, input.pricingScopeKey)
    )[0] ?? null;
}

export async function calculateMarketRateAdjustment(
  provider: MarketRateProvider,
  input: MarketRateAdjustmentInput
): Promise<MarketRateAdjustmentResult> {
  const selectedRule = await selectBestMarketAdjustmentRule(provider, {
    marketId: input.marketResolution.market.id,
    pricingScopeType: input.pricingScopeType,
    pricingScopeKey: input.pricingScopeKey,
    asOf: input.asOf,
  });

  const weights = normalizeWeights(selectedRule, input.componentBreakdown);
  const componentAdjustments = buildComponentAdjustments(selectedRule, input.baselinePrice, weights);
  const adjustedPrice = roundCurrency(
    componentAdjustments.reduce((sum, component) => sum + component.adjustedAmount, 0)
  );

  return {
    market: input.marketResolution.market,
    resolutionLevel: input.marketResolution.resolutionLevel,
    resolutionSource: input.marketResolution.resolutionSource,
    baselinePrice: input.baselinePrice,
    selectedRule,
    componentAdjustments,
    adjustedPrice,
    rationale: {
      resolvedMarket: input.marketResolution.market,
      resolutionLevel: input.marketResolution.resolutionLevel,
      resolutionSource: input.marketResolution.resolutionSource,
      baselinePrice: input.baselinePrice,
      selectedRuleId: selectedRule?.id ?? null,
      componentAdjustments,
    },
  };
}
