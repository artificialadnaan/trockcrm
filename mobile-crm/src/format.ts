/**
 * Display helpers. Deliberately tiny and dependency-free.
 *
 * The money one matters most: Postgres `numeric` serialises to a STRING, so every amount arrives as
 * "125000.00". Passing that to a number-typed formatter yields NaN, which renders as literal "NaN" on a
 * phone rather than failing loudly — the kind of bug you ship.
 */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * `date` columns arrive as "YYYY-MM-DD". Parsing that with `new Date()` treats it as UTC midnight, which
 * renders as the PREVIOUS day for anyone west of Greenwich — so split the parts and build a local date.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Whole days since an ISO timestamp — for "N days in stage". Null when unknown, never a fake 0. */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/** The city/state line under a deal name. Omits the separator when only one side is present. */
export function formatLocation(city: string | null | undefined, state: string | null | undefined): string {
  const parts = [city?.trim(), state?.trim()].filter(Boolean);
  return parts.length ? parts.join(", ") : "";
}
