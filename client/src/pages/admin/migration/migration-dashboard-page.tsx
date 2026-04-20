import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Play,
  ArrowUpRight,
  Rows3,
  UsersRound,
  UserCog,
  Link2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { useMigrationSummary, useMigrationExceptions } from "@/hooks/use-migration";
import { useSalesReview } from "@/hooks/use-sales-review";
import {
  applyOwnershipSync,
  listAssignableUsers,
  previewOwnershipSync,
  reassignOwnership,
  type AssignableUser,
  type OwnershipSyncPreview,
} from "@/hooks/use-ownership-cleanup";
import { useAuth } from "@/lib/auth";

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

function prettifyIssue(value: string) {
  return value.replace(/_/g, " ");
}

function prettifyReason(value: string | null) {
  return value ? value.replace(/_/g, " ") : null;
}

function OwnershipWorkspaceSection({ isAdmin }: { isAdmin: boolean }) {
  const { data, loading, error, refetch } = useSalesReview();
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selectedAssignments, setSelectedAssignments] = useState<Record<string, string>>({});
  const [updatingDealId, setUpdatingDealId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [ownershipPreview, setOwnershipPreview] = useState<OwnershipSyncPreview | null>(null);

  const ownershipRows = useMemo(
    () =>
      (data?.hygiene ?? []).filter(
        (row) =>
          row.entityType === "deal" &&
          (
            row.issueTypes.includes("unassigned_owner") ||
            row.issueTypes.includes("owner_mapping_failure") ||
            row.issueTypes.includes("inactive_owner_mapping")
          ),
      ),
    [data],
  );

  useEffect(() => {
    async function loadAssignableUsers() {
      setUsersLoading(true);
      setUsersError(null);
      try {
        const nextUsers = await listAssignableUsers();
        setAssignableUsers(nextUsers);
      } catch (err) {
        setUsersError(err instanceof Error ? err.message : "Failed to load assignable users");
      } finally {
        setUsersLoading(false);
      }
    }

    loadAssignableUsers();
  }, []);

  const unmatchedCount = ownershipRows.filter((row) => row.unassignedReasonCode === "owner_mapping_failure").length;
  const inactiveCount = ownershipRows.filter((row) => row.unassignedReasonCode === "inactive_owner_mapping").length;
  const missingOwnerCount = ownershipRows.filter((row) => row.unassignedReasonCode === "missing_hubspot_owner").length;

  const handlePreview = async () => {
    setPreviewLoading(true);
    try {
      const preview = await previewOwnershipSync();
      setOwnershipPreview(preview);
      toast.success(`Previewed ${preview.summary.scannedCount} active HubSpot-owned deals`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to preview ownership sync");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    setApplyLoading(true);
    try {
      const summary = await applyOwnershipSync();
      await refetch();
      toast.success(`Ownership sync applied to ${summary.updatedCount} records`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply ownership sync");
    } finally {
      setApplyLoading(false);
    }
  };

  const handleAssign = async (dealId: string) => {
    const userId = selectedAssignments[dealId];
    if (!userId) {
      toast.error("Select a user before reassigning");
      return;
    }

    setUpdatingDealId(dealId);
    try {
      await reassignOwnership(dealId, userId);
      await refetch();
      toast.success("Ownership updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reassign owner");
    } finally {
      setUpdatingDealId(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Ownership Seeding And Cleanup</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Inherit HubSpot deal owners into CRM assignments, then route unresolved records to directors and admins for reassignment.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
                <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh Queue
              </Button>
              {isAdmin ? (
                <>
                  <Button variant="outline" size="sm" onClick={handlePreview} disabled={previewLoading}>
                    <Link2 className="mr-1 h-4 w-4" />
                    {previewLoading ? "Previewing..." : "Preview Sync"}
                  </Button>
                  <Button size="sm" onClick={handleApply} disabled={applyLoading}>
                    <Play className="mr-1 h-4 w-4" />
                    {applyLoading ? "Applying..." : "Apply Sync"}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {usersError ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {usersError}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Office Ownership Queue</p>
              <p className="mt-2 text-3xl font-semibold">{ownershipRows.length}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Missing HubSpot Owner</p>
              <p className="mt-2 text-3xl font-semibold">{missingOwnerCount}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Owner Mapping Failures</p>
              <p className="mt-2 text-3xl font-semibold">{unmatchedCount}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Inactive Owner Mappings</p>
              <p className="mt-2 text-3xl font-semibold">{inactiveCount}</p>
            </div>
          </div>

          {ownershipPreview ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <div className="grid gap-3 md:grid-cols-3">
                <p><span className="font-medium">Scanned:</span> {ownershipPreview.summary.scannedCount}</p>
                <p><span className="font-medium">Matched:</span> {ownershipPreview.summary.matchedCount}</p>
                <p><span className="font-medium">Updated:</span> {ownershipPreview.summary.updatedCount}</p>
                <p><span className="font-medium">Missing owner:</span> {ownershipPreview.summary.missingHubspotOwnerCount}</p>
                <p><span className="font-medium">Mapping failures:</span> {ownershipPreview.summary.ownerMappingFailureCount}</p>
                <p><span className="font-medium">Manual overrides preserved:</span> {ownershipPreview.summary.manualOverrideCount}</p>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {ownershipRows.map((row) => (
              <div key={row.id} className="rounded-lg border bg-white p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-slate-900">{row.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.stageId} • {row.assignedRepName ?? "Unassigned"}
                    </p>
                  </div>
                  <Link
                    to={`/deals/${row.id}`}
                    className="inline-flex items-center text-sm font-medium text-brand-red hover:underline"
                  >
                    Open
                    <ArrowUpRight className="ml-1 h-4 w-4" />
                  </Link>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {row.issueTypes.map((issue) => (
                    <Badge key={issue} variant="outline" className="border-red-200 text-red-700">
                      {prettifyIssue(issue)}
                    </Badge>
                  ))}
                </div>

                <div className="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                  <p>
                    <span className="font-medium text-slate-700">Decision maker:</span>{" "}
                    {row.decisionMakerName ?? "Missing"}
                  </p>
                  <p>
                    <span className="font-medium text-slate-700">Budget status:</span>{" "}
                    {row.budgetStatus ?? "Missing"}
                  </p>
                  <p>
                    <span className="font-medium text-slate-700">Next step:</span>{" "}
                    {row.nextStep ?? "Missing"}
                  </p>
                  <p>
                    <span className="font-medium text-slate-700">Ownership sync:</span>{" "}
                    {row.ownershipSyncStatus ?? "Not synced"}
                  </p>
                  {row.unassignedReasonCode ? (
                    <p className="md:col-span-2">
                      <span className="font-medium text-slate-700">Reassignment reason:</span>{" "}
                      {prettifyReason(row.unassignedReasonCode)}
                    </p>
                  ) : null}
                </div>

                <div className="mt-4 flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Reassign owner
                    </label>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={selectedAssignments[row.id] ?? ""}
                      onChange={(event) =>
                        setSelectedAssignments((current) => ({
                          ...current,
                          [row.id]: event.target.value,
                        }))
                      }
                      disabled={usersLoading}
                    >
                      <option value="">Select user</option>
                      {assignableUsers.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName} ({user.email})
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    onClick={() => handleAssign(row.id)}
                    disabled={updatingDealId === row.id || usersLoading}
                    className="md:self-end"
                  >
                    <UserCog className="mr-1 h-4 w-4" />
                    {updatingDealId === row.id ? "Reassigning..." : "Assign owner"}
                  </Button>
                </div>
              </div>
            ))}

            {!loading && ownershipRows.length === 0 ? (
              <div className="rounded-lg border bg-white p-6 text-sm text-muted-foreground">
                No ownership exceptions are currently waiting for reassignment.
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

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
                Open the rep-scoped cleanup queue for missing forecast fields, stale next steps, and ownership gaps.
              </p>
            </div>
            <ArrowUpRight className="h-4 w-4 text-slate-300 group-hover:text-blue-600" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function AdminMigrationSummarySection() {
  const { summary, loading, error, refetch, runValidation } = useMigrationSummary();
  const {
    exceptions,
    loading: exceptionsLoading,
    error: exceptionsError,
    refetch: refetchExceptions,
  } = useMigrationExceptions();
  const [validating, setValidating] = useState(false);
  const exceptionTotal = exceptions.reduce((sum, group) => sum + group.count, 0);

  const handleValidate = async () => {
    setValidating(true);
    try {
      await runValidation();
      await Promise.all([refetch(), refetchExceptions()]);
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="space-y-6">
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

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide">
            Migration Validation
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run validation and review unresolved staging exceptions before promotion.
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

export function MigrationDashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            {isAdmin ? "HubSpot Migration" : "Ownership Cleanup"}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {isAdmin
              ? "Seed HubSpot ownership into CRM, resolve unassigned records, and keep the migration queues moving."
              : "Resolve office ownership exceptions and reassign unassigned HubSpot-owned deals."}
          </p>
        </div>
        <Badge className="bg-slate-100 text-slate-700">
          <UsersRound className="mr-1 h-4 w-4" />
          {isAdmin ? "Admin Controls" : "Director Reassignment"}
        </Badge>
      </div>

      <OwnershipWorkspaceSection isAdmin={isAdmin} />

      {isAdmin ? <AdminMigrationSummarySection /> : null}
    </div>
  );
}
