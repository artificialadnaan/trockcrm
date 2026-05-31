// Shared number/$ formatters for the report surfaces. Null-guarded on purpose: a newly-nullable field now
// surfaces as an em dash ("—"), never the string "undefined" — defense-in-depth so callers don't have to
// remember `?? 0`. Single source; re-exported from evidence-kit so existing `import { usd } from "./evidence-kit"`
// keeps working.
export const usd = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const int = (n: number | null | undefined): string => (n == null ? "—" : n.toLocaleString("en-US"));

export const signed = (n: number | null | undefined): string =>
  n == null ? "—" : n > 0 ? `+${n.toLocaleString("en-US")}` : n.toLocaleString("en-US");
