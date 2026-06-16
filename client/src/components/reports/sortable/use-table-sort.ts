import { useMemo, useState } from "react";
import {
  compareDate,
  compareNumber,
  compareText,
  type ColumnType,
  type SortDirection,
} from "./comparators";

export type { ColumnType, SortDirection } from "./comparators";

export interface SortColumn<Row> {
  key: string;
  type: ColumnType;
  accessor: (row: Row) => string | number | null | undefined;
  // Direction-agnostic base order (the hook negates it for "desc"). Use for columns
  // whose order isn't a plain field value (e.g. an enum sorted by an explicit rank).
  compare?: (a: Row, b: Row) => number;
}

export interface SortState {
  key: string;
  dir: SortDirection;
}

export interface UseTableSortOptions {
  initialSort?: SortState | null;
}

export interface UseTableSortResult<Row> {
  sortedRows: Row[];
  sortState: SortState | null;
  toggle: (key: string) => void;
  getHeaderProps: (key: string) => { active: boolean; dir: SortDirection | null };
}

function defaultDir(type: ColumnType): SortDirection {
  return type === "text" ? "asc" : "desc";
}

export function useTableSort<Row>(
  rows: Row[],
  columns: ReadonlyArray<SortColumn<Row>>,
  options: UseTableSortOptions = {},
): UseTableSortResult<Row> {
  const [sortState, setSortState] = useState<SortState | null>(options.initialSort ?? null);

  const columnMap = useMemo(() => {
    const m = new Map<string, SortColumn<Row>>();
    for (const c of columns) m.set(c.key, c);
    return m;
  }, [columns]);

  function toggle(key: string) {
    const col = columnMap.get(key);
    if (!col) return;
    setSortState((cur) =>
      cur && cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultDir(col.type) },
    );
  }

  const sortedRows = useMemo(() => {
    if (!sortState) return rows;
    const col = columnMap.get(sortState.key);
    if (!col) return rows;
    const dir = sortState.dir;
    const indexed = rows.map((row, index) => ({ row, index }));
    indexed.sort((a, b) => {
      let cmp: number;
      if (col.compare) {
        cmp = col.compare(a.row, b.row);
        if (dir === "desc") cmp = -cmp;
      } else {
        const av = col.accessor(a.row);
        const bv = col.accessor(b.row);
        cmp =
          col.type === "number"
            ? compareNumber(av as number | null | undefined, bv as number | null | undefined, dir)
            : col.type === "date"
              ? compareDate(av as string | null | undefined, bv as string | null | undefined, dir)
              : compareText(av as string | null | undefined, bv as string | null | undefined, dir);
      }
      // Explicit stable tiebreak: equal keys (incl. nullish ties) keep server order.
      return cmp !== 0 ? cmp : a.index - b.index;
    });
    return indexed.map((entry) => entry.row);
  }, [rows, sortState, columnMap]);

  function getHeaderProps(key: string): { active: boolean; dir: SortDirection | null } {
    const active = sortState?.key === key;
    return { active, dir: active ? sortState!.dir : null };
  }

  return { sortedRows, sortState, toggle, getHeaderProps };
}
