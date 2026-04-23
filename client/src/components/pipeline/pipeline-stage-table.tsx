import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface PipelineStagePagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PipelineStageTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

interface PipelineStageTableProps<T> {
  rows: T[];
  columns: Array<PipelineStageTableColumn<T>>;
  pagination: PipelineStagePagination;
  onPageChange: (page: number) => void;
  onRowClick?: (row: T) => void;
  getRowKey?: (row: T, index: number) => string;
}

export function PipelineStageTable<T>({
  rows,
  columns,
  pagination,
  onPageChange,
  onRowClick,
  getRowKey,
}: PipelineStageTableProps<T>) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-[11px] font-black tracking-[0.18em] text-slate-500 uppercase">
          {pagination.total} total records
        </p>
        <p className="text-sm font-medium text-slate-500">
          Page {pagination.page} of {pagination.totalPages || 1}
        </p>
      </div>
      <Table className="overflow-hidden rounded-[1.25rem]">
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.key}
                className="border-b border-slate-200 bg-[#f7f8fb] px-4 py-3 text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase"
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow
              key={getRowKey ? getRowKey(row, index) : String(index)}
              className={cn(
                "border-b border-slate-100 hover:bg-slate-50/80",
                onRowClick ? "cursor-pointer" : ""
              )}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <TableCell key={column.key} className="px-4 py-4 align-top text-sm text-slate-700">
                  {column.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-end gap-2 px-1">
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => onPageChange(pagination.page - 1)}
            className="rounded-full"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => onPageChange(pagination.page + 1)}
            className="rounded-full"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
      </div>
    </div>
  );
}
