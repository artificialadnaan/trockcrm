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

/**
 * The scope title a CHANGE-ORDER child deal is created with.
 *
 * A CO child is a real deal row, so it has its own scope_title column and its own detail page and export
 * row. The question this answers is what that column starts as — and it is a SEED, not inheritance. The
 * child's title is independent from that moment on: editing it is normal, and drift from the parent is
 * correct behaviour, not a bug to propagate away.
 *
 * That is settled by the production data, not by preference. Across all 36 change-order children in the
 * live tenant (2026-08-05):
 *   - 0 of 36 had a description matching their parent's;
 *   - 34 of 36 described work plainly distinct from the parent's ("Return unused allowances" under an
 *     exterior-reclad job; "Drill holes and complete moisture reading" under "50 stucco hole patches");
 *   - those descriptions are ALREADY title-shaped: min 15 chars, median 33, and 33 of 34 within the cap.
 * So showing the parent's title on the child would mislabel every real change order, and the best
 * available default is the CO's own description — which is, in practice, exactly the short scope name
 * accounting would have typed ("CE#001 Stucco Repairs", "Panel Relocation", "Tile & Plumbing Alt").
 *
 * Order:
 *   1. the CO's own description, when it is single-line and already fits the cap — the 97% case;
 *   2. else the parent's scope title, so a CO with no usable description of its own is still named by
 *      its project rather than left blank in accounting's export;
 *   3. else null.
 *
 * Multi-line is excluded deliberately: a description with a "Scope of Work:" block below it is a notes
 * field again, and squeezing its first 120 characters into a title is how the wall-of-text problem gets
 * re-created one field over.
 */
export function deriveChangeOrderScopeTitle(
  input: { changeOrderDescription?: string | null; parentScopeTitle?: string | null },
  maxLength: number = DEAL_SCOPE_TITLE_MAX_LENGTH
): string | null {
  const ownDescription = (input.changeOrderDescription ?? "").trim();
  if (
    ownDescription !== "" &&
    ownDescription.length <= maxLength &&
    !/[\r\n]/.test(ownDescription)
  ) {
    return ownDescription;
  }

  const inherited = (input.parentScopeTitle ?? "").trim();
  // Cannot exceed the cap in practice (the column is varchar(maxLength)) — guarded so a hand-widened or
  // imported parent value can never make the CO insert fail with a 22001 the user cannot act on.
  if (inherited !== "" && inherited.length <= maxLength) {
    return inherited;
  }

  return null;
}

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
