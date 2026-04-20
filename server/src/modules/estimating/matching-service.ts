export interface RankExtractionMatchesArgs {
  extraction: {
    normalizedLabel: string;
    unit?: string | null;
    divisionHint?: string | null;
  };
  catalogItems: Array<{
    id: string;
    name: string;
    unit?: string | null;
    primaryCode?: string | null;
    catalogBaselinePrice?: string | number | null;
  }>;
  historicalItems: Array<{
    id: string;
    description: string;
    unit?: string | null;
    costCode?: string | null;
    unitPrice?: string | number | null;
    vendorQuotePrice?: number | null;
  }>;
}

export function deriveInternalAdjustmentPercent(
  item: { unit?: string | null; primaryCode?: string | null },
  extraction: { unit?: string | null; divisionHint?: string | null }
) {
  if (item.unit && extraction.unit && item.unit !== extraction.unit) return -5;
  if (item.primaryCode && extraction.divisionHint && !item.primaryCode.startsWith(extraction.divisionHint)) return -3;
  return 0;
}

export function deriveAwardedOutcomeAdjustment(
  similarHistory: Array<{ id: string }>
) {
  return similarHistory.length >= 3 ? -2 : 0;
}

export async function rankExtractionMatches({
  extraction,
  catalogItems,
  historicalItems,
}: RankExtractionMatchesArgs) {
  const normalizedLabel = extraction.normalizedLabel.toLowerCase();

  return catalogItems
    .map((item) => {
      const similarHistory = historicalItems.filter((historicalItem) => {
        return (
          historicalItem.description.toLowerCase().includes(normalizedLabel) ||
          historicalItem.costCode === item.primaryCode
        );
      });

      return {
        catalogItemId: item.id,
        historicalLineItemIds: similarHistory.map((row) => row.id),
        historicalUnitPrices: similarHistory
          .map((row) => Number(row.unitPrice))
          .filter((value) => Number.isFinite(value)),
        catalogBaselinePrice:
          item.catalogBaselinePrice != null ? Number(item.catalogBaselinePrice) : null,
        vendorQuotePrice:
          similarHistory.find((row) => row.vendorQuotePrice != null)?.vendorQuotePrice ?? null,
        awardedOutcomeAdjustmentPercent:
          similarHistory.length > 0 ? deriveAwardedOutcomeAdjustment(similarHistory) : 0,
        internalAdjustmentPercent: deriveInternalAdjustmentPercent(item, extraction),
        matchScore:
          (item.name.toLowerCase() === normalizedLabel ? 50 : 0) +
          (item.unit && extraction.unit && item.unit === extraction.unit ? 15 : 0) +
          (item.primaryCode?.startsWith(extraction.divisionHint ?? "") ? 15 : 0) +
          Math.min(similarHistory.length * 10, 20),
        reasons: {
          exactNameMatch: item.name.toLowerCase() === normalizedLabel,
          unitMatched: item.unit === extraction.unit,
          historicalCount: similarHistory.length,
        },
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore);
}
