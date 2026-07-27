/**
 * Display helpers. Deliberately tiny and dependency-free.
 *
 * The money one matters most: Postgres `numeric` serialises to a STRING, so every amount arrives as
 * "125000.00". Passing that to a number-typed formatter yields NaN, which renders as literal "NaN" on a
 * phone rather than failing loudly — the kind of bug you ship.
 */
export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  // TRIMMED before the emptiness test. Number("   ") is 0, not NaN, so a whitespace-only value slipped
  // past both guards and rendered "$0" — a confident wrong number where the em dash means "no value".
  if (typeof value === "string" && value.trim() === "") return "—";
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
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const d = new Date(year, month - 1, day);
    // The regex only proves the SHAPE is digits. "2026-02-31" passes it, and the Date constructor
    // silently rolls that over to 3 March — a plausible wrong date is worse than a dash, because
    // nothing about it looks wrong. Reject anything the constructor moved. Mirrors the same guard in
    // shared/src/types/deal-hold-risk.ts calendarDay.
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return "—";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  const d = new Date(value);
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
