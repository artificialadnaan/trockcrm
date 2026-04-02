import { useState, Fragment } from "react";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAuditLog } from "@/hooks/use-audit-log";

const ACTION_BADGE: Record<string, string> = {
  insert: "bg-green-100 text-green-800",
  update: "bg-blue-100 text-blue-800",
  delete: "bg-red-100 text-red-800",
};

export function AuditLogPage() {
  const { rows, total, page, setPage, loading, filter, setFilter, tables } = useAuditLog();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const totalPages = Math.ceil(total / 50);

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Audit Log</h1>
          <p className="text-sm text-gray-500 mt-1">{total.toLocaleString()} entries</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 p-4 rounded-lg border bg-gray-50">
        <Filter className="h-4 w-4 text-gray-400" />
        <Select
          value={filter.tableName ?? ""}
          onValueChange={(v) => setFilter((f) => ({ ...f, tableName: v || undefined }))}
        >
          <SelectTrigger className="w-36 h-8 text-sm">
            <SelectValue placeholder="All tables" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All tables</SelectItem>
            {tables.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filter.action ?? ""}
          onValueChange={(v) => setFilter((f) => ({ ...f, action: v || undefined }))}
        >
          <SelectTrigger className="w-28 h-8 text-sm">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All actions</SelectItem>
            <SelectItem value="insert">Insert</SelectItem>
            <SelectItem value="update">Update</SelectItem>
            <SelectItem value="delete">Delete</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="From date (YYYY-MM-DD)"
          className="h-8 w-44 text-sm"
          value={filter.fromDate ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, fromDate: e.target.value || undefined }))}
        />
        <Input
          placeholder="To date (YYYY-MM-DD)"
          className="h-8 w-40 text-sm"
          value={filter.toDate ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, toDate: e.target.value || undefined }))}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-gray-500"
          onClick={() => setFilter({})}
        >
          Clear
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Table</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Changed By</TableHead>
              <TableHead>Record ID</TableHead>
              <TableHead>Changes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-gray-400 py-8">Loading...</TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-gray-400 py-8">No audit entries</TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  >
                    <TableCell className="text-xs text-gray-500 whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-gray-100 px-1 rounded">{row.tableName}</code>
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${ACTION_BADGE[row.action] ?? ""}`}>
                        {row.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.changedByName ?? (row.changedBy ? `${row.changedBy.slice(0, 8)}...` : "System")}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-gray-500">
                      {row.recordId.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="text-xs text-gray-600">
                      {row.action === "update"
                        ? `${Object.keys(row.changes).length} field(s) changed`
                        : row.action === "insert"
                        ? "New record"
                        : "Record deleted"}
                    </TableCell>
                  </TableRow>
                  {expandedId === row.id && (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-gray-50 p-0">
                        <div className="p-4">
                          <div className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
                            Change details
                          </div>
                          <pre className="text-xs font-mono bg-white border rounded-md p-3 overflow-x-auto max-h-48 overflow-y-auto">
                            {JSON.stringify(
                              row.action === "update" ? row.changes : row.fullRow,
                              null,
                              2
                            )}
                          </pre>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>Page {page} of {totalPages} ({total.toLocaleString()} entries)</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => setPage(page - 1)} disabled={page <= 1}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={page >= totalPages}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
