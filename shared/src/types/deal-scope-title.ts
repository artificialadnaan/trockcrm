/**
 * deals.scope_title — the short, accounting-readable title for a deal's scope of work.
 *
 * Accounting keys a project title into QuickBooks and today has to mine it out of `description`, a
 * 5000-char notes field. The value of this field is entirely in its BREVITY: "Balcony Repair",
 * "Plumbing Renovations", "Unit Build Back". A cap that only the form enforces is not a cap — any
 * non-form caller (script, importer, raw HTTP) would put the wall of text straight back. So the number
 * lives HERE, in shared, and is the single source for:
 *
 *   - the client form's counter + inline error   (client/src/components/deals/deal-form.tsx)
 *   - the API rejection                          (server .../deals/routes.ts validateDealPayload)
 *   - the column width                           (migrations/0218_deals_scope_title.sql, varchar(120))
 *
 * If this number ever changes, the varchar must change with it in a new migration — the column is the
 * backstop, and a shared constant wider than the column turns a clean 400 into a Postgres 22001/500.
 */
export const DEAL_SCOPE_TITLE_MAX_LENGTH = 120;

/** Placeholder/help examples, taken verbatim from the accounting request that asked for the field. */
export const DEAL_SCOPE_TITLE_EXAMPLES = [
  "Unit Build Back",
  "Plumbing Renovations",
  "Balcony Repair",
] as const;

export type DealScopeTitleValidation =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Normalize + length-check one scope-title input.
 *
 * Trims first, then measures — otherwise trailing whitespace can push an otherwise-legal title over the
 * cap and produce an error the user cannot see the cause of. A blank (or whitespace-only) input is the
 * UNSET value and normalizes to null, matching how the form clears every other optional text field.
 *
 * Length is measured in JS string units, the same units the form's counter shows and the same units
 * Postgres varchar(n) counts for the BMP characters this field realistically holds. (Both would count an
 * astral emoji as 2 where Postgres counts 1 — that direction is conservative: the form and API reject
 * slightly before the column would, never after.)
 */
export function validateDealScopeTitle(
  raw: unknown,
  maxLength: number = DEAL_SCOPE_TITLE_MAX_LENGTH
): DealScopeTitleValidation {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "scopeTitle must be a string or null" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      error: `scopeTitle must be ${maxLength} characters or fewer`,
    };
  }
  return { ok: true, value: trimmed };
}
