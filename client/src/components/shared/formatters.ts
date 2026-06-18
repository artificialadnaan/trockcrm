export const USD = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

export const USD_COMPACT = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
    // Coerce non-finite (NaN / ±Infinity from an upstream divide or a missing total) to 0 so a KPI card
    // renders "$0" instead of the user-facing "$NaN".
  }).format(Number.isFinite(value) ? value : 0);

export const NUMBER_COMPACT = (value: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
