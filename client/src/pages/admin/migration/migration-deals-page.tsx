import { useState } from "react";
import { CheckCircle2, XCircle, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useStagedDeals } from "@/hooks/use-migration";
import { formatCurrency } from "@/lib/deal-utils";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "valid", label: "Valid" },
  { value: "needs_review", label: "Needs Review" },
  { value: "invalid", label: "Invalid" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "promoted", label: "Promoted" },
];

const STATUS_BADGE: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  promoted: "bg-purple-100 text-purple-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  rejected: "bg-gray-100 text-gray-500",
  pending: "bg-gray-100 text-gray-600",
};

export function MigrationDealsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("needs_review");
  const {
    rows,
    total,
    page,
    setPage,
    loading,
    selected,
    setSelected,
    approve,
    reject,
    batchApprove,
  } = useStagedDeals(statusFilter || undefined);

  const totalPages = Math.ceil(total / 50);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">
          Staged Deals <span className="text-gray-400 text-lg">({total.toLocaleString()})</span>
        </h1>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "")}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected.size > 0 && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={batchApprove}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              Approve {selected.size} selected
            </Button>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                checked={selected.size === rows.length && rows.length > 0}
                onCheckedChange={toggleAll}
              />
            </TableHead>
            <TableHead>Deal Name</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Rep Email</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Issues</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                Loading...
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                No records with this status
              </TableCell>
            </TableRow>
          ) : (
            rows.map((deal) => (
              <TableRow key={deal.id} className={selected.has(deal.id) ? "bg-blue-50" : ""}>
                <TableCell>
                  {deal.validationStatus !== "promoted" && (
                    <Checkbox
                      checked={selected.has(deal.id)}
                      onCheckedChange={() => toggleSelect(deal.id)}
                    />
                  )}
                </TableCell>
                <TableCell className="font-medium max-w-[200px] truncate">
                  {deal.mappedName ?? "--"}
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-gray-100 px-1 rounded">
                    {deal.mappedStage ?? "--"}
                  </code>
                </TableCell>
                <TableCell className="text-sm text-gray-600 max-w-[160px] truncate">
                  {deal.mappedRepEmail ?? "--"}
                </TableCell>
                <TableCell className="text-sm">
                  {deal.mappedAmount != null ? formatCurrency(deal.mappedAmount) : "--"}
                </TableCell>
                <TableCell>
                  <Badge className={`text-xs ${STATUS_BADGE[deal.validationStatus] ?? ""}`}>
                    {deal.validationStatus.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    {deal.validationErrors.map((e, i) => (
                      <div key={i} className="text-xs text-red-600">
                        {e.field}: {e.error}
                      </div>
                    ))}
                    {deal.validationWarnings.map((w, i) => (
                      <div key={i} className="text-xs text-amber-600">
                        {w.field}: {w.warning}
                      </div>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  {deal.validationStatus !== "promoted" &&
                    deal.validationStatus !== "rejected" && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-green-700 hover:bg-green-50"
                          onClick={() => approve(deal.id)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-red-700 hover:bg-red-50"
                          onClick={() => reject(deal.id)}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                          Reject
                        </Button>
                      </div>
                    )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            Page {page} of {totalPages} ({total.toLocaleString()} total)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
