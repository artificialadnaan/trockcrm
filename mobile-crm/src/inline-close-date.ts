/**
 * The inline expected-close-date gate.
 *
 * Some stage advances are blocked solely because the deal has no `expectedCloseDate`. The server accepts
 * that field in the SAME stage-change POST and re-validates against the pending value, so the move can be
 * completed in one action — which is exactly what the web dialog does.
 *
 * Without it, mobile could not perform those advances AT ALL: the screen listed a missing field, left
 * Confirm disabled, and offered no way to supply it, because this app has no deal-edit path. A dead end
 * whose only escape was to go and use the desktop app.
 *
 * Mirrors client/src/components/deals/stage-change-dialog.tsx:116-143. It lives in the web component
 * rather than in shared, so this is a hand copy — the third mirrored rule in this app, and the previous
 * two were both wrong on their first attempt, so the exclusions below are transcribed with their reasons
 * intact rather than summarised.
 */

export type InlineCloseDateGate = {
  missingRequirements?: { fields?: string[]; documents?: string[]; approvals?: string[] } | null;
  isBackwardMove?: boolean | null;
  currentStageSlug?: string | null;
  /** preflight.bidBoardLocked — a read-only Bid Board mirror; the route forces allowed=false for it. */
  bidBoardLocked?: boolean | null;
};

/**
 * True when the ONLY thing blocking the gate is a missing expectedCloseDate that the inline prompt can
 * actually clear.
 *
 * EVERY exclusion below is load-bearing — each is a block the inline date does NOT clear, so unblocking
 * on it would swap a disabled button for a server rejection:
 *   - backward move: the override is for the DIRECTION, not the field.
 *   - close_out: the close-out-checklist rule can require an override on close_out → won with no
 *     missingRequirements footprint at all, giving a 400 OVERRIDE_REQUIRED.
 *   - bidBoardLocked: preflight forces allowed=false for a read-only mirror regardless of requirements.
 */
export function isExpectedCloseDateSoleGateBlocker(gate: InlineCloseDateGate): boolean {
  const fields = gate.missingRequirements?.fields ?? [];
  return (
    fields.length === 1 &&
    fields.includes("expectedCloseDate") &&
    (gate.missingRequirements?.documents?.length ?? 0) === 0 &&
    (gate.missingRequirements?.approvals?.length ?? 0) === 0 &&
    !gate.isBackwardMove &&
    gate.currentStageSlug !== "close_out" &&
    !gate.bidBoardLocked
  );
}

/**
 * True when the supplied date actually resolves the gate: sole clearable blocker AND a usable
 * (today-or-later) value. When true the POST re-validates with the pending date and the server no longer
 * requires an override — so the override-reason requirement, which preflight computed before this value
 * existed, must be skipped rather than demanded.
 */
export function isGateResolvedByInlineCloseDate(
  gate: InlineCloseDateGate,
  expectedCloseDate: string,
  today: string,
): boolean {
  return isExpectedCloseDateSoleGateBlocker(gate) && isUsableCloseDate(expectedCloseDate, today);
}

/** Today in the BUSINESS timezone as YYYY-MM-DD. */
export function businessTodayDateStr(now: Date = new Date()): string {
  // en-CA gives ISO-ordered YYYY-MM-DD. America/Chicago rather than the device zone or UTC: the server's
  // stage gate anchors its usable-date check to CT, and a rep entering CT-today late in the evening —
  // when UTC has already rolled over — must not be told their own today is in the past.
  return now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/**
 * A well-formed, real, today-or-later calendar date.
 *
 * The strict shape check comes first because both comparisons here are STRING comparisons: they are only
 * meaningful on zero-padded ISO dates, and "2026-7-9" would compare wrong rather than fail loudly. The
 * round-trip catches dates that are well-formed but do not exist — the Date constructor rolls "2026-02-31"
 * forward to March 3 rather than rejecting it, the same trap that once made this app render a nonexistent
 * day as if it were real.
 */
export function isUsableCloseDate(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  if (parsed.toISOString().slice(0, 10) !== value) return false;
  return value >= today;
}

/** YYYY-MM-DD for `days` from today in the business timezone — backs the quick-pick chips. */
export function businessDateInDays(days: number, now: Date = new Date()): string {
  const base = new Date(`${businessTodayDateStr(now)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
