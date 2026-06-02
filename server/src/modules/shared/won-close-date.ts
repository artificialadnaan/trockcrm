/**
 * WRITE-TIME contract-signed override for the canonical Won-close date.
 *
 * Background (read this before touching Won logic): the canonical Won-period axis is the
 * app-owned `deals.won_closed_date` column (migration 0141), read everywhere through the
 * single SQL helper `aliasedWonHsClosedWonDateSql` (deal-value-sql.ts). A prior attempt to
 * COALESCE contract_signed over won_closed_date at READ time silently moved one surface off
 * the reconciled basis (deal-date-scope.ts §; Codex #546). We therefore override at WRITE
 * time instead: the writers populate the ONE stored column, so every read surface — including
 * the report-builder DATE_FIELDS literal and the monday-showcase evidence SELECT that bypass
 * the helper, plus the backfill/parity scripts — inherits the corrected date by reading the
 * same column. No read path changes.
 *
 * The rule is "always-when-present": for a deal that IS in the Won family, a populated
 * contract_signed_date is accounting's authoritative correction of the won-close date and
 * ALWAYS wins; when it is absent the stage-driven won date (fresh stamp, preserved value, or
 * stage-entry date) stands. Whether the deal is Won-family is the CALLER's responsibility —
 * this resolver must NEVER be used to promote a non-Won deal (membership stays gated by stage
 * slug at every call site).
 */
export function resolveWonClosedDateWriteThrough(opts: {
  /** The deal's contract_signed_date (YYYY-MM-DD) — accounting's correction lever. */
  contractSignedDate: string | null | undefined;
  /** The stage-driven won date that stands when no contract-signed date is present. */
  stageDrivenWonDate: string | null | undefined;
}): string | null {
  // Empty string / undefined are treated as "absent" (a DB date column is null or a real
  // YYYY-MM-DD string, never ""); only a populated contract-signed date overrides.
  const contractSigned = opts.contractSignedDate || null;
  if (contractSigned) return contractSigned;
  return opts.stageDrivenWonDate ?? null;
}
