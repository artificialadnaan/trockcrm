/**
 * Solo vs mixed commission structure — the single source of truth for turning a rep's stored
 * structure + two capX rates into the EFFECTIVE rates the engine applies. The settings-save
 * mirrors resolveEffectiveCapxRate(...) into user_commission_settings.commission_rate so every
 * existing engine read (which reads commission_rate) stays untouched (the "denormalized mirror").
 */
export type CommissionStructure = "solo" | "mixed";

export interface CommissionStructureRates {
  commissionStructure: CommissionStructure;
  capxRateSolo: number;
  capxRateMixed: number;
  serviceSourceRate: number;
}

export function isCommissionStructure(value: unknown): value is CommissionStructure {
  return value === "solo" || value === "mixed";
}

/** The capX rate that applies to the rep's own owned deals under their active structure. */
export function resolveEffectiveCapxRate(rates: CommissionStructureRates): number {
  return rates.commissionStructure === "mixed" ? rates.capxRateMixed : rates.capxRateSolo;
}

/**
 * The rate applied to service deals this rep SOURCED. Only live under the mixed structure —
 * a solo rep with a stray serviceSourceRate value never earns a sales-source cut.
 */
export function resolveEffectiveServiceSourceRate(rates: CommissionStructureRates): number {
  return rates.commissionStructure === "mixed" ? rates.serviceSourceRate : 0;
}
