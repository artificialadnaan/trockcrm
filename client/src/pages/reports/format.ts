// Shared number/$ formatters for the report surfaces. Null-guarded on purpose: a newly-nullable field now
// surfaces as an em dash ("—"), never the string "undefined" — defense-in-depth so callers don't have to
// remember `?? 0`. Single source; re-exported from evidence-kit so existing `import { usd } from "./evidence-kit"`
// keeps working.
export const usd = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Exact-cents currency — for PAYOUT figures (earned/potential commission) where the $0.01 matters and a
// rounded-to-whole-dollar display would misstate what a rep is owed. Use over `usd` for money amounts.
export const usdExact = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const int = (n: number | null | undefined): string => (n == null ? "—" : n.toLocaleString("en-US"));

export const signed = (n: number | null | undefined): string =>
  n == null ? "—" : n > 0 ? `+${n.toLocaleString("en-US")}` : n.toLocaleString("en-US");

// Win probability is sparsely filled (~1% of deals). A MISSING value means "unknown", NOT zero — so
// null/undefined/NaN must render the em dash, never "NaN%" or a misleading "0%". A real stored 0 is a
// value and renders "0%". The deal's win_probability is shown as-is (never computed or inferred).
export const winPct = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? "—" : `${n}%`;
