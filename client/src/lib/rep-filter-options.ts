export interface RepFilterOption {
  id: string;
  displayName: string;
  /**
   * Which question this person answers — "sales" (owns) or "estimator" (is estimating).
   *
   * Optional because an APPENDED off-roster selection has no group: the wide assignee feed knows the
   * person's name and nothing else about them. Callers partitioning the list must treat a missing group
   * as "sales", the historical meaning of every entry here, so an appended id can never vanish from both
   * sections and become unselectable.
   */
  group?: "sales" | "estimator";
}

/**
 * The rep options a filter control should offer: the sales roster, PLUS the current selection when it
 * falls outside the roster.
 *
 * Why the "plus" matters (Codex P2). The roster is deliberately narrow — unticking "Generates Sales"
 * removes someone even while they own live deals — but a URL, a bookmark or a drill-down can still pin a
 * board to an off-roster owner. Feeding the raw roster into the shared FilterSelect makes the control LIE
 * about that: `filter-select.tsx` resolves its label with
 *
 *     items.find((item) => item.value === current)?.label ?? allLabel
 *
 * so an unmatched selection renders as "All reps" while the board stays narrowed to one person. A filter
 * that reports the opposite of what it is doing is worse than a filter offering an extra name.
 *
 * Appending the selection fixes the label, keeps the value selectable, and lets the user clear it — while
 * the dropdown still offers only the roster for every OTHER choice, which is the point of the change.
 *
 * The name comes from the wide assignee feed, the only source that can name someone off-roster. When even
 * that cannot resolve it (a deactivated or deleted user) the honest fallback is "Selected rep": vague, but
 * it still tells the truth that SOMETHING is selected.
 */
/**
 * Filter values that are NOT user ids and must never be appended as a person.
 *
 * `__unassigned__` is the deals FilterBar's own option — it prepends
 * `{ value: "__unassigned__", label: "Unassigned" }` itself. Treating it as an off-roster user produced a
 * SECOND option with the same value, so the control rendered "Unassigned" and "Selected rep" side by side
 * on duplicate keys; on the leads list, where the adapter deliberately drops the sentinel from the query,
 * a bookmarked value showed as a selected person while filtering nothing (Codex P2).
 */
const RESERVED_FILTER_VALUES = new Set(["__all__", "__unassigned__"]);

export function buildRepFilterOptions(
  roster: RepFilterOption[],
  selectedId: string | null | undefined,
  resolveName: (id: string) => string | undefined,
  fallbackLabel = "Selected rep"
): RepFilterOption[] {
  if (!selectedId || RESERVED_FILTER_VALUES.has(selectedId)) return roster;
  if (roster.some((rep) => rep.id === selectedId)) return roster;
  return [...roster, { id: selectedId, displayName: resolveName(selectedId) ?? fallbackLabel }];
}
