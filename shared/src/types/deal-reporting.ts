type DealReportabilityLike = {
  onHold?: boolean | null;
};

const SQL_IDENTIFIER_PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

export function isDealActivelyOnHold(deal: DealReportabilityLike): boolean {
  return deal.onHold === true;
}

export function isReportableDeal(deal: DealReportabilityLike): boolean {
  return !isDealActivelyOnHold(deal);
}

export function reportableDealSqlPredicate(identifierPath?: string): string {
  if (!identifierPath) {
    return "COALESCE(on_hold, false) = false";
  }

  if (!SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid reportable deal SQL identifier: ${identifierPath}`);
  }

  return `COALESCE(${identifierPath}.on_hold, false) = false`;
}
