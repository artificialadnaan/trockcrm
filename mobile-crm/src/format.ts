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

/**
 * A timestamp with its TIME, for the one column that has one.
 *
 * `scheduled_for` is `timestamptz` and the web dialog lets someone pick the hour, so a task set for 9am
 * and one set for 3pm are different commitments — rendering both as "Aug 14" collapsed them. `due_date`
 * is a Postgres `date` and deliberately does NOT come through here: there is no time to show, and
 * inventing "12:00 AM" would be a claim the data never made.
 *
 * Falls back to the date alone for a value with no time component, so a caller passing the wrong shape
 * degrades to `formatDate`'s answer rather than to a fake midnight.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

/**
 * A full postal address on ONE line — the thing a rep actually needs to drive to.
 *
 * `formatLocation` answers "roughly where"; a company row rendered only that, so a record with a
 * street address and no city read "—" while the server was returning the street the whole time
 * (`getTableColumns(companies)` includes `address` and `zip`). Withholding the exact location from a
 * field app is the failure this fixes.
 *
 * Written as street / locality / ZIP so the ZIP hangs off the city-state pair the way a mailing label
 * does — "1200 Main St, Dallas, TX 75201" — and every piece is optional, because in this data most of
 * them frequently are. Returns "" rather than a lonely separator when nothing is on file, so a caller
 * can fall back to its own placeholder.
 */
export function formatPostalAddress(
  address: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
  zip: string | null | undefined
): string {
  const locality = [formatLocation(city, state), zip?.trim()].filter(Boolean).join(" ");
  return [address?.trim(), locality].filter(Boolean).join(", ");
}

/**
 * A database enum token, as a person would read it.
 *
 * These reach the app raw — `property_manager`, `general_contractor`, `mixed_use` — and every screen
 * that rendered one published the column value. The uppercase card style made it worse, turning
 * `property_manager` into "PROPERTY_MANAGER", and because those labels are also the accessible name,
 * VoiceOver read the underscore out.
 *
 * Mirrors `client/src/lib/display-format.ts`'s `formatEnumLabel` rather than inventing a second rule,
 * because a category has to read the same on the phone as it does on the web — mobile-crm sits outside
 * the npm workspace and cannot import it. Kept to the parts that apply here: separator splitting and
 * the single-word capital. The web's date and boolean special cases have no enum call site on mobile.
 *
 * Unknown values pass through unchanged. A token the server adds tomorrow should render as itself
 * rather than vanish — a missing category reads as "we have no category", which would be a lie.
 */
export function formatEnumLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  if (/[_-]/.test(trimmed)) {
    return trimmed
      .split(/[_-]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
      .join(" ");
  }
  if (/^[a-z][a-z0-9]*$/.test(trimmed)) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return trimmed;
}
