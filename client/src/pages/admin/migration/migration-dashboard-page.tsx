import { CheckCircle2, XCircle, Clock, RefreshCw, Play, ArrowUpRight, Rows3, Filter } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useAccessibleOffices } from "@/hooks/use-accessible-offices";
import {
  bulkReassignOwnershipQueueRows,
  useMigrationSummary,
  useMigrationExceptions,
  useOfficeOwnershipQueue,
  type OwnershipQueueRow,
  type OwnershipQueueFilters,
} from "@/hooks/use-migration";
import { OwnershipQueueTable } from "@/components/admin/ownership-queue-table";
import { OwnershipReassignDialog } from "@/components/admin/ownership-reassign-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const STATUS_COLORS: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  promoted: "bg-red-100 text-red-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  duplicate: "bg-orange-100 text-orange-800",
  rejected: "bg-gray-100 text-gray-800",
  orphan: "bg-red-100 text-red-800",
  pending: "bg-gray-100 text-gray-600",
};

function StatCard({
  label,
  stats,
  href,
}: {
  label: string;
  stats: Record<string, number>;
  href?: string;
}) {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const issues = (stats.invalid ?? 0) + (stats.duplicate ?? 0) + (stats.orphan ?? 0);
  const approved = (stats.approved ?? 0) + (stats.promoted ?? 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-gray-500 uppercase tracking-wide">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-gray-900 mb-3">{total.toLocaleString()}</div>
        <div className="space-y-1">
          {Object.entries(stats).map(([status, count]) => (
            <div key={status} className="flex items-center justify-between text-sm">
              <Badge className={`text-xs ${STATUS_COLORS[status] ?? "bg-gray-100"}`}>
                {status.replace(/_/g, " ")}
              </Badge>
              <span className="font-medium text-gray-700">{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
        {issues > 0 && href && (
          <Link to={href}>
            <Button variant="outline" size="sm" className="mt-3 w-full text-red-700 border-red-300">
              Review {issues} issues
            </Button>
          </Link>
        )}
        {issues === 0 && approved > 0 && (
          <div className="mt-3 flex items-center gap-1 text-sm text-green-600">
            <CheckCircle2 className="h-4 w-4" />
            Ready to promote
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExceptionBucketCard({
  label,
  count,
  items,
}: {
  label: string;
  count: number;
  items: Array<{
    id: string;
    entityType: string;
    title: string;
    detail: string;
    reviewHint: string;
    reviewable: boolean;
  }>;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium text-gray-500 uppercase tracking-wide">
              {label}
            </CardTitle>
            <div className="text-2xl font-semibold text-gray-900 mt-1">{count}</div>
          </div>
          <Badge className="bg-amber-100 text-amber-800">Review</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item) => (
          <div key={item.id} className="rounded-md border bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{item.title}</div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">{item.entityType}</div>
              </div>
              <Badge className="bg-gray-100 text-gray-700">{item.reviewable ? "Inline" : "Read-only"}</Badge>
            </div>
            <p className="mt-2 text-sm text-gray-600">{item.detail}</p>
            <p className="mt-1 text-xs text-amber-700">{item.reviewHint}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function getOwnershipQueueRowKey(row: OwnershipQueueRow) {
  return `${row.recordType}:${row.recordId}`;
}

const RECORD_TYPE_OPTIONS = [
  { value: "all", label: "All record types" },
  { value: "lead", label: "Leads" },
  { value: "deal", label: "Deals" },
] as const;

const STALE_AGE_OPTIONS = [
  { value: "all", label: "All ages" },
  { value: "7", label: "7+ days" },
  { value: "14", label: "14+ days" },
  { value: "30", label: "30+ days" },
  { value: "60", label: "60+ days" },
] as const;

export function MigrationDashboardPage() {
  const { user } = useAuth();
  const { offices, loading: officesLoading } = useAccessibleOffices();
  const { summary, loading, error, refetch, runValidation } = useMigrationSummary();
  const {
    exceptions,
    loading: exceptionsLoading,
    error: exceptionsError,
    refetch: refetchExceptions,
  } = useMigrationExceptions();
  const [selectedOfficeId, setSelectedOfficeId] = useState<string | undefined>(undefined);
  const [recordTypeFilter, setRecordTypeFilter] = useState<"all" | "lead" | "deal">("all");
  const [reasonCodeFilter, setReasonCodeFilter] = useState<string>("all");
  const [staleAgeFilter, setStaleAgeFilter] = useState<"all" | "7" | "14" | "30" | "60">("all");
  const [officeFilterError, setOfficeFilterError] = useState<string | null>(null);
  const accessibleOfficeIds = useMemo(() => new Set(offices.map((office) => office.id)), [offices]);
  const defaultOfficeId = useMemo(() => {
    const currentOfficeId = user?.activeOfficeId ?? user?.officeId;
    if (currentOfficeId && accessibleOfficeIds.has(currentOfficeId)) {
      return currentOfficeId;
    }
    return offices[0]?.id;
  }, [accessibleOfficeIds, offices, user?.activeOfficeId, user?.officeId]);
  const officeId = selectedOfficeId ?? defaultOfficeId;
  const selectedOffice = useMemo(
    () => offices.find((office) => office.id === officeId) ?? null,
    [officeId, offices]
  );
  const selectedOfficeName = selectedOffice?.name ?? "selected office";
  const ownershipFilters = useMemo(
    () => ({
      officeId,
      recordType: recordTypeFilter,
      reasonCode: reasonCodeFilter !== "all" ? reasonCodeFilter : undefined,
      staleAgeDays: staleAgeFilter === "all" ? "all" : Number(staleAgeFilter),
    }) satisfies OwnershipQueueFilters,
    [officeId, recordTypeFilter, reasonCodeFilter, staleAgeFilter]
  );
  const {
    rows: ownershipRows,
    byReason: ownershipReasons,
    loading: ownershipLoading,
    error: ownershipError,
    refetch: refetchOwnershipQueue,
  } = useOfficeOwnershipQueue(ownershipFilters);
  const [validating, setValidating] = useState(false);
  const [selectedOwnershipKeys, setSelectedOwnershipKeys] = useState<Set<string>>(new Set());
  const [reassignOpen, setReassignOpen] = useState(false);
  const exceptionTotal = exceptions.reduce((sum, group) => sum + group.count, 0);

  useEffect(() => {
    if (selectedOfficeId) return;
    if (defaultOfficeId) {
      setSelectedOfficeId(defaultOfficeId);
    }
  }, [defaultOfficeId, selectedOfficeId]);

  useEffect(() => {
    if (selectedOfficeId && !offices.some((office) => office.id === selectedOfficeId)) {
      setOfficeFilterError("Selected office is no longer available.");
      setSelectedOfficeId(undefined);
      return;
    }
    setOfficeFilterError(null);
  }, [offices, selectedOfficeId]);

  const filteredOwnershipRows = useMemo(() => {
    const staleThreshold = staleAgeFilter === "all" ? null : Number(staleAgeFilter);
    const now = Date.now();

    return ownershipRows.filter((row) => {
      if (recordTypeFilter !== "all" && row.recordType !== recordTypeFilter) return false;
      if (reasonCodeFilter !== "all" && !row.reasonCodes.includes(reasonCodeFilter)) return false;
      if (staleThreshold != null) {
        const timestamp = row.evaluatedAt ?? row.generatedAt;
        if (!timestamp) return false;
        const ageDays = (now - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
        if (Number.isNaN(ageDays) || ageDays < staleThreshold) return false;
      }
      return true;
    });
  }, [ownershipRows, reasonCodeFilter, recordTypeFilter, staleAgeFilter]);

  const selectedOwnershipRows = useMemo(
    () => filteredOwnershipRows.filter((row) => selectedOwnershipKeys.has(getOwnershipQueueRowKey(row))),
    [filteredOwnershipRows, selectedOwnershipKeys]
  );

  const allVisibleOwnershipSelected = filteredOwnershipRows.length > 0
    && filteredOwnershipRows.every((row) => selectedOwnershipKeys.has(getOwnershipQueueRowKey(row)));

  const toggleOwnershipRow = (row: OwnershipQueueRow) => {
    const next = new Set(selectedOwnershipKeys);
    const key = getOwnershipQueueRowKey(row);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedOwnershipKeys(next);
  };

  const toggleAllVisibleOwnershipRows = () => {
    if (allVisibleOwnershipSelected) {
      setSelectedOwnershipKeys(new Set());
      return;
    }

    setSelectedOwnershipKeys(new Set(filteredOwnershipRows.map((row) => getOwnershipQueueRowKey(row))));
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      await runValidation();
      await Promise.all([refetch(), refetchExceptions()]);
    } finally {
      setValidating(false);
    }
  };

  const handleReassignOwnershipRows = async (assigneeId: string) => {
    if (!officeId) {
      throw new Error("No office is currently selected");
    }

    await bulkReassignOwnershipQueueRows({
      officeId,
      assigneeId,
      rows: selectedOwnershipRows.map((row) => ({
        recordType: row.recordType,
        recordId: row.recordId,
      })),
    });
    setSelectedOwnershipKeys(new Set());
    await Promise.all([refetchOwnershipQueue(), refetch()]);
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">HubSpot Migration</h1>
          <p className="text-sm text-gray-500 mt-1">
            3-phase pipeline: Extract, Validate, Promote
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={handleValidate}
            disabled={validating}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Play className="h-4 w-4 mr-1" />
            {validating ? "Validating..." : "Run Validation"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatCard label="Deals" stats={summary.deals} href="/admin/migration/deals" />
          <StatCard label="Contacts" stats={summary.contacts} href="/admin/migration/contacts" />
          <StatCard label="Activities" stats={summary.activities} />
          <StatCard label="Companies" stats={summary.companies} />
          <StatCard label="Properties" stats={summary.properties} />
          <StatCard label="Leads" stats={summary.leads} />
        </div>
      )}

      <Card className="border-amber-200 bg-gradient-to-br from-amber-50 via-white to-slate-50">
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-sm font-medium uppercase tracking-wide text-amber-900">
                Office Ownership Queue
              </CardTitle>
              <p className="text-sm text-slate-600">
                Unassigned active records are waiting for a valid CRM owner before they can leave migration cleanup.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={refetchOwnershipQueue} disabled={ownershipLoading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${ownershipLoading ? "animate-spin" : ""}`} />
                Refresh Queue
              </Button>
              <Button
                size="sm"
                onClick={() => setReassignOpen(true)}
                disabled={selectedOwnershipRows.length === 0 || !officeId}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                Reassign selected
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                <Filter className="h-3.5 w-3.5" />
                Office
              </div>
              <Select value={selectedOfficeId ?? ""} onValueChange={(value) => setSelectedOfficeId(value || undefined)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={officesLoading ? "Loading offices..." : "Select office"} />
                </SelectTrigger>
                <SelectContent>
                  {offices.map((office) => (
                    <SelectItem key={office.id} value={office.id}>
                      {office.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Record type</div>
              <Select
                value={recordTypeFilter}
                onValueChange={(value) =>
                  setRecordTypeFilter((value ?? "all") as typeof recordTypeFilter)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Reason code</div>
              <Select value={reasonCodeFilter} onValueChange={(value) => setReasonCodeFilter(value ?? "all")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All reasons" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All reasons</SelectItem>
                  {ownershipReasons.map((reason) => (
                    <SelectItem key={reason.reasonCode} value={reason.reasonCode}>
                      {reason.reasonCode.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Stale age</div>
              <Select
                value={staleAgeFilter}
                onValueChange={(value) =>
                  setStaleAgeFilter((value ?? "all") as typeof staleAgeFilter)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STALE_AGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {officeFilterError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {officeFilterError}
            </div>
          )}

          {ownershipError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {ownershipError}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {ownershipReasons.length > 0 ? (
              ownershipReasons.map((reason) => (
                <Badge key={reason.reasonCode} variant="secondary" className="bg-white text-slate-700">
                  {reason.reasonCode.replace(/_/g, " ")} · {reason.count}
                </Badge>
              ))
            ) : (
              <div className="text-sm text-slate-500">No queue reasons are currently active.</div>
            )}
          </div>

          <div className="rounded-xl border border-amber-100 bg-white/80 shadow-sm">
            <OwnershipQueueTable
              rows={filteredOwnershipRows}
              loading={ownershipLoading}
              selectedRowKeys={selectedOwnershipKeys}
              onToggleRow={toggleOwnershipRow}
              onToggleAllVisible={toggleAllVisibleOwnershipRows}
              allVisibleSelected={allVisibleOwnershipSelected}
            />
          </div>
        </CardContent>
      </Card>

      <OwnershipReassignDialog
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        officeId={officeId}
        officeName={selectedOfficeName}
        rows={selectedOwnershipRows}
        onReassign={handleReassignOwnershipRows}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-500 uppercase tracking-wide">
            Data Hygiene
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Link
            to="/pipeline/hygiene"
            className="group flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:bg-slate-50"
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Rows3 className="h-4 w-4 text-slate-400 group-hover:text-blue-600" />
                <h3 className="text-sm font-semibold text-gray-900">Pipeline Hygiene</h3>
              </div>
              <p className="text-sm leading-relaxed text-gray-600">
                Review stale or incomplete lead and deal records that need cleanup outside the live sidebar navigation.
              </p>
            </div>
            <ArrowUpRight className="h-4 w-4 text-slate-300 group-hover:text-blue-600" />
          </Link>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide">
            Migration Exceptions
          </h2>
          <div className="text-xs text-gray-500">
            {exceptionTotal.toLocaleString()} unresolved mappings
          </div>
          <Button variant="outline" size="sm" onClick={refetchExceptions} disabled={exceptionsLoading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${exceptionsLoading ? "animate-spin" : ""}`} />
            Refresh Exceptions
          </Button>
        </div>

        {exceptionsError && (
          <div className="rounded-md bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
            {exceptionsError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {exceptions.map((group) => (
            <ExceptionBucketCard
              key={group.bucket}
              label={group.label}
              count={group.count}
              items={group.items}
            />
          ))}
        </div>
      </div>

      {/* Recent runs */}
      {summary?.recentRuns && summary.recentRuns.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide mb-3">
            Recent Import Runs
          </h2>
          <div className="space-y-2">
            {summary.recentRuns.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between rounded-md border bg-white p-3"
              >
                <div className="flex items-center gap-3">
                  {run.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : run.status === "failed" || run.status === "rolled_back" ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : (
                    <Clock className="h-4 w-4 text-amber-500" />
                  )}
                  <div>
                    <span className="font-medium text-sm capitalize">{run.type}</span>
                    <span className="text-xs text-gray-500 ml-2">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>
                  </div>
                </div>
                <Badge
                  className={
                    run.status === "completed"
                      ? "bg-green-100 text-green-800"
                      : run.status === "running"
                      ? "bg-blue-100 text-blue-800"
                      : "bg-red-100 text-red-800"
                  }
                >
                  {run.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase instructions */}
      <div className="rounded-lg border bg-amber-50 border-amber-200 p-4">
        <h3 className="font-medium text-amber-900 mb-2">Migration Steps</h3>
        <ol className="text-sm text-amber-800 space-y-1 list-decimal list-inside">
          <li>
            Run extract script on Railway:{" "}
            <code className="bg-amber-100 px-1 rounded font-mono text-xs">
              railway run npx tsx scripts/migration-extract.ts
            </code>
          </li>
          <li>Click "Run Validation" above to auto-validate all staged records</li>
          <li>
            Review flagged deals in{" "}
            <Link to="/admin/migration/deals" className="underline font-medium">
              Deals
            </Link>{" "}
            and contacts in{" "}
            <Link to="/admin/migration/contacts" className="underline font-medium">
              Contacts
            </Link>
          </li>
          <li>
            Promote approved records:{" "}
            <code className="bg-amber-100 px-1 rounded font-mono text-xs">
              OFFICE_SLUG=dallas railway run npx tsx scripts/migration-promote.ts
            </code>
          </li>
        </ol>
      </div>
    </div>
  );
}
