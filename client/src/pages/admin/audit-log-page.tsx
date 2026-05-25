import { ChevronLeft, ChevronRight, Filter, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAuditLog } from "@/hooks/use-audit-log";
import { ActivityFeedEntry } from "@/components/audit/activity-feed-entry";

const ACTION_OPTIONS = [
  { value: "insert", label: "Created" },
  { value: "update", label: "Updated" },
  { value: "soft_delete", label: "Deleted" },
];

export function AuditLogPage() {
  const {
    rows,
    total,
    totalLoading,
    totalError,
    hasMore,
    page,
    setPage,
    loading,
    filter,
    setFilter,
    entityTypes,
    loadGroupChildren,
  } = useAuditLog();
  const totalPages = total == null ? null : Math.max(1, Math.ceil(total / 50));
  const totalLabel = totalLoading && total == null
    ? "Loading total..."
    : totalError
      ? "Total unavailable"
      : total == null
        ? "Recent activity"
        : `${total.toLocaleString()} entries`;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">All Activity</h1>
          <p className="mt-1 text-sm text-slate-500">{totalLabel}</p>
        </div>
      </div>

      <section className="grid gap-3 rounded-lg border bg-slate-50 p-4 md:grid-cols-4">
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">User</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              className="pl-8"
              placeholder="Actor name"
              value={filter.actorQuery ?? ""}
              onChange={(event) => setFilter((current) => ({ ...current, actorQuery: event.target.value || undefined }))}
            />
          </div>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Entity</span>
          <Select
            value={filter.entityType ?? "__all__"}
            onValueChange={(value) =>
              setFilter((current) => ({
                ...current,
                entityType: value === "__all__" ? undefined : value ?? undefined,
              }))
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="All entities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All entities</SelectItem>
              {entityTypes.map((entityType) => (
                <SelectItem key={entityType} value={entityType}>{entityType}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Action</span>
          <Select
            value={filter.action ?? "__all__"}
            onValueChange={(value) =>
              setFilter((current) => ({
                ...current,
                action: value === "__all__" ? undefined : value ?? undefined,
              }))
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All actions</SelectItem>
              {ACTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">From</span>
            <Input
              type="date"
              value={filter.fromDate ?? ""}
              onChange={(event) => setFilter((current) => ({ ...current, fromDate: event.target.value || undefined }))}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">To</span>
            <Input
              type="date"
              value={filter.toDate ?? ""}
              onChange={(event) => setFilter((current) => ({ ...current, toDate: event.target.value || undefined }))}
            />
          </label>
        </div>

        <div className="md:col-span-4 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setFilter({})}>
            <Filter className="mr-1.5 h-4 w-4" />
            Clear filters
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        {loading ? (
          <div className="rounded-lg border bg-white px-4 py-8 text-center text-sm text-slate-500">Loading activity...</div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border bg-white px-4 py-8 text-center text-sm text-slate-500">No activity found.</div>
        ) : (
          rows.map((entry) => <ActivityFeedEntry key={entry.id} entry={entry} onLoadGroupChildren={loadGroupChildren} />)
        )}
      </section>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{totalPages == null ? `Page ${page}` : `Page ${page} of ${totalPages}`}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setPage(page - 1)} disabled={page <= 1}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={totalPages == null ? !hasMore : page >= totalPages}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
