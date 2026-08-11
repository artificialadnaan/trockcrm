/**
 * The ONE definition of the order corrective-action rows are presented in.
 *
 * Three surfaces render the same record — the PDF, the oversight email, and the deal thread — and they must
 * agree, because a reader compares them. They previously each sorted by `item_ref`, which is wrong in a way
 * that only shows up after an edit: reconciliation deliberately PRESERVES an action item's original
 * `item_ref` (it re-matches on `item_label`) so that reordering the list cannot orphan an already-settled
 * response. So once the list is reordered, `item_ref` order is the OLD order, and every surface sorting by it
 * contradicts the action-item list printed directly above it.
 *
 * There is a second, subtler consumer: the PDF loader slices response photos to a global cap BEFORE handing
 * them to the renderer. If the loader's order differs from the renderer's, the cap keeps photos for one item
 * and the renderer draws a different one — so an item can lose its evidence entirely. Any surface that ranks
 * these rows for ANY reason must use this function.
 */

/** The minimum a row needs to be ordered. */
export interface CorrectiveActionOrderable {
  /** 'action_item' | 'critical_deficiency' */
  itemType: string;
  /** Action-item index as a string, or the critical-deficiency key. */
  itemRef: string;
  itemLabel: string;
}

/**
 * Stable base order: critical deficiencies before action items, then NUMERICALLY by ref for action items —
 * "10" must follow "2", not precede it. Deficiency refs are opaque keys and fall back to lexical only when no
 * live deficiency list is supplied.
 *
 * DEFICIENCIES FIRST because that is what every other surface shows. The scorecard body renders "Critical
 * Deficiencies" above "Action Items" in the same PDF, and the CRM detail threads responses under the same two
 * sections in the same order. An earlier version of this sorter put action items first with a comment
 * claiming it "matches the deal-thread order" — it did not, and any card carrying both kinds disagreed with
 * itself one page apart.
 */
export function compareCorrectiveActionsByRef(
  left: CorrectiveActionOrderable,
  right: CorrectiveActionOrderable,
): number {
  if (left.itemType !== right.itemType) return left.itemType === "critical_deficiency" ? -1 : 1;
  const leftNum = Number(left.itemRef);
  const rightNum = Number(right.itemRef);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return leftNum - rightNum;
  return left.itemRef.localeCompare(right.itemRef);
}

/**
 * Order rows by their position in the CURRENT action-item list.
 *
 * Duplicate labels consume their positions in base-ref order, so two identically-worded action items keep
 * distinct ranks instead of both collapsing onto the first occurrence. A row the list no longer contains — a
 * critical deficiency, or a settled row whose action item an edit removed — ranks last and keeps its base
 * order, so it stays somewhere predictable rather than moving around between renders.
 *
 * Passing an empty `actionItems` yields the base ref order, which is the correct fallback rather than a
 * degenerate one: with no list to rank against, ref order is the best-known order.
 */
export function orderCorrectiveActions<T extends CorrectiveActionOrderable>(
  rows: readonly T[],
  actionItems: readonly string[],
  criticalDeficiencyKeys: readonly string[] = [],
): T[] {
  const refOrdered = [...rows].sort(compareCorrectiveActionsByRef);

  const positions = new Map<string, number[]>();
  actionItems.forEach((label, index) => {
    const key = label.trim();
    const bucket = positions.get(key);
    if (bucket) bucket.push(index);
    else positions.set(key, [index]);
  });

  // Deficiencies rank by their position in the STORED key array, which is the order the card body renders
  // them in — not lexically. A card whose deficiencies were selected out of alphabetical order would
  // otherwise list its corrective actions in a different order from the deficiencies section above them.
  const deficiencyRank = new Map<string, number>();
  criticalDeficiencyKeys.forEach((key, index) => {
    const trimmed = key.trim();
    if (!deficiencyRank.has(trimmed)) deficiencyRank.set(trimmed, index);
  });

  const rankByRow = new Map<T, number>();
  for (const row of refOrdered) {
    if (row.itemType === "critical_deficiency") {
      const rank = deficiencyRank.get(row.itemRef.trim());
      if (rank !== undefined) rankByRow.set(row, rank);
      continue;
    }
    // shift(), so a second row sharing a label takes the NEXT occurrence rather than colliding on the first.
    const position = positions.get(row.itemLabel.trim())?.shift();
    if (position !== undefined) rankByRow.set(row, position);
  }

  // Array#sort is stable, so equal ranks (and every unranked row) retain the base ref ordering above.
  return refOrdered.sort((left, right) => {
    if (left.itemType !== right.itemType) return left.itemType === "critical_deficiency" ? -1 : 1;
    const leftRank = rankByRow.get(left) ?? Number.POSITIVE_INFINITY;
    const rightRank = rankByRow.get(right) ?? Number.POSITIVE_INFINITY;
    if (leftRank === rightRank) return 0;
    return leftRank - rightRank;
  });
}
