import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OwnershipQueueRow } from "@/hooks/use-migration";

function formatTimestamp(value: string | null) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function severityClasses(severity: OwnershipQueueRow["severity"]) {
  if (severity === "high") return "bg-red-100 text-red-800";
  if (severity === "medium") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

interface OwnershipQueueTableProps {
  rows: OwnershipQueueRow[];
  loading?: boolean;
  selectedRowKeys: Set<string>;
  onToggleRow: (row: OwnershipQueueRow) => void;
  onToggleAllVisible: () => void;
  allVisibleSelected: boolean;
}

export function getOwnershipQueueRowKey(row: OwnershipQueueRow) {
  return `${row.recordType}:${row.recordId}`;
}

export function OwnershipQueueTable({
  rows,
  loading,
  selectedRowKeys,
  onToggleRow,
  onToggleAllVisible,
  allVisibleSelected,
}: OwnershipQueueTableProps) {
  const selectedCount = useMemo(() => selectedRowKeys.size, [selectedRowKeys]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <Checkbox
              checked={allVisibleSelected && rows.length > 0}
              onCheckedChange={onToggleAllVisible}
              aria-label="Select all visible ownership queue rows"
            />
          </TableHead>
          <TableHead>Record</TableHead>
          <TableHead>Office</TableHead>
          <TableHead>Reasons</TableHead>
          <TableHead>Severity</TableHead>
          <TableHead>Evaluated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          <TableRow>
            <TableCell colSpan={6} className="py-8 text-center text-gray-400">
              Loading ownership queue...
            </TableCell>
          </TableRow>
        ) : rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="py-8 text-center text-gray-400">
              No unassigned active records for this office.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => {
            const rowKey = getOwnershipQueueRowKey(row);
            const selected = selectedRowKeys.has(rowKey);

            return (
              <TableRow key={rowKey} className={selected ? "bg-amber-50/70" : ""}>
                <TableCell>
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => onToggleRow(row)}
                    aria-label={`Select ${row.recordName}`}
                  />
                </TableCell>
                <TableCell className="min-w-0">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{row.recordName}</span>
                      <Badge variant="outline" className="h-5 text-[11px] uppercase tracking-wide">
                        {row.recordType}
                      </Badge>
                    </div>
                    <div className="text-xs text-slate-500">
                      Assigned to {row.assignedUserName ?? "Unassigned"}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-slate-600">{row.officeName}</TableCell>
                <TableCell className="max-w-[360px]">
                  <div className="flex flex-wrap gap-1">
                    {row.reasonCodes.map((reasonCode) => (
                      <Badge key={reasonCode} variant="secondary" className="text-xs">
                        {reasonCode.replace(/_/g, " ")}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge className={`text-xs ${severityClasses(row.severity)}`}>{row.severity}</Badge>
                </TableCell>
                <TableCell className="text-xs text-slate-500">
                  <div>{formatTimestamp(row.evaluatedAt)}</div>
                  {selectedCount > 0 && selected && (
                    <div className="text-amber-700">Selected</div>
                  )}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
