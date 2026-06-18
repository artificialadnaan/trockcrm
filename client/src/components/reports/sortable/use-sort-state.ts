import { useMemo, useState } from "react";
import type { ColumnType, SortDirection } from "./comparators";

export type { ColumnType, SortDirection } from "./comparators";

export interface SortState {
  key: string;
  dir: SortDirection;
}

/** Minimal column spec the STATE machine needs — just the key and its type (for the default direction). */
export interface SortStateColumn {
  key: string;
  type: ColumnType;
}

export interface UseSortStateOptions {
  initialSort?: SortState | null;
}

export interface UseSortStateResult {
  sortState: SortState | null;
  toggle: (key: string) => void;
  getHeaderProps: (key: string) => { active: boolean; dir: SortDirection | null };
}

export function defaultDir(type: ColumnType): SortDirection {
  return type === "text" ? "asc" : "desc";
}

/**
 * The pure toggle rule (no React): clicking the active key flips its direction; clicking any other key
 * switches to it at the column type's default direction. Shared by useSortState AND by server-side list
 * pages whose sort lives in EXTERNAL state (a persisted filter object) — so the rule never diverges between
 * client-side and server-side sorting.
 */
export function nextSortState(current: SortState | null, key: string, type: ColumnType): SortState {
  return current && current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: defaultDir(type) };
}

/** Pure header render props for a column given the active sort state. */
export function sortHeaderProps(
  sortState: SortState | null,
  key: string,
): { active: boolean; dir: SortDirection | null } {
  const active = sortState?.key === key;
  return { active, dir: active ? sortState!.dir : null };
}

/**
 * The headless sort STATE machine — one active `{key, dir}` (or null), a toggle that flips direction on
 * the active key and otherwise switches to a column at its type's default direction (text → asc,
 * number/date → desc), and per-column header render props. It holds NO data and does NO sorting; it is the
 * shared core behind both useTableSort (client-side, sorts the in-memory array) and the server-side list
 * pages (which forward `sortState` to the API so the FULL filtered set is ordered, not just the page).
 * Keeping the toggle/default-direction logic here means the two never diverge.
 */
export function useSortState(
  columns: ReadonlyArray<SortStateColumn>,
  options: UseSortStateOptions = {},
): UseSortStateResult {
  const [sortState, setSortState] = useState<SortState | null>(options.initialSort ?? null);

  const typeByKey = useMemo(() => {
    const m = new Map<string, ColumnType>();
    for (const c of columns) m.set(c.key, c.type);
    return m;
  }, [columns]);

  function toggle(key: string) {
    const type = typeByKey.get(key);
    if (!type) return; // unknown key → no-op
    setSortState((cur) => nextSortState(cur, key, type));
  }

  function getHeaderProps(key: string): { active: boolean; dir: SortDirection | null } {
    return sortHeaderProps(sortState, key);
  }

  return { sortState, toggle, getHeaderProps };
}
