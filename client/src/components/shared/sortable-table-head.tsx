import type { ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { SortHeaderButton, type SortDirection } from "@/components/reports/sortable";

interface SortableTableHeadProps {
  label: ReactNode;
  active: boolean;
  dir: SortDirection | null;
  numeric?: boolean;
  onSort: () => void;
  /** Cell-level classes (alignment, width) applied to the <th>. */
  className?: string;
  /** Typography classes applied to the clickable button wrapping the label. */
  buttonClassName?: string;
}

/**
 * A shadcn <TableHead> whose label is the Reports SortHeaderButton (clickable, 3-state caret), with the
 * matching aria-sort on the host cell. A thin markup helper that composes the EXISTING sort primitives —
 * it owns no sort state/logic; callers pass active/dir/onSort from useSortState (client-side) or from the
 * page's filter state via sortHeaderProps/nextSortState (server-side). Use a plain <TableHead> for columns
 * that aren't sortable (e.g. computed aggregates with no orderable backing).
 */
export function SortableTableHead({
  label,
  active,
  dir,
  numeric,
  onSort,
  className,
  buttonClassName,
}: SortableTableHeadProps) {
  return (
    <TableHead
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={className}
    >
      <SortHeaderButton
        label={label}
        active={active}
        dir={dir}
        numeric={numeric}
        onClick={onSort}
        className={buttonClassName}
      />
    </TableHead>
  );
}
