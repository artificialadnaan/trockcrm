import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw, AlertTriangle, CheckCircle2, XCircle, Zap, Clock, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import {
  buildProcoreValidationSectionState,
  buildValidationSummary,
  formatValidationMatchReason,
  type ProcoreAuthStatus,
} from "@/lib/procore-validation-view-model";

interface SyncSummary {
  synced: number;
  pending: number;
  conflict: number;
  error: number;
}

interface SyncConflict {
  id: string;
  entityType: string;
  procoreId: number;
  crmEntityType: string;
  crmEntityId: string;
  syncStatus: string;
  conflictData: Record<string, unknown> | null;
  errorMessage: string | null;
  updatedAt: string;
}

interface SyncActivityRow {
  id: string;
  entityType: string;
  procoreId: number;
  crmEntityType: string;
  crmEntityId: string;
  syncDirection: string;
  syncStatus: string;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

interface CircuitBreaker {
  state: "closed" | "open" | "half_open";
  failures: number;
  openedAt: number | null;
}

interface SyncStatusResponse {
  summary: SyncSummary;
  conflicts: SyncConflict[];
  recentActivity: SyncActivityRow[];
  lastSyncedAt: string | null;
  circuit_breaker: CircuitBreaker;
}

interface ProjectValidationProject {
  id: number;
  name: string | null;
  projectNumber: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  updatedAt: string | null;
}

interface ProjectValidationDeal {
  id: string;
  dealNumber: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  procoreProjectId: number | null;
  updatedAt: string | null;
}

interface ProjectValidationRow {
  project: ProjectValidationProject;
  deal: ProjectValidationDeal | null;
  status: "matched" | "ambiguous" | "unmatched";
  matchReason:
    | "procore_project_id"
    | "duplicate_procore_project_id"
    | "project_number"
    | "duplicate_project_number"
    | "name_location"
    | "name_location_tie"
    | "none";
}

interface ProjectValidationMeta {
  companyId: string;
  fetchedCount: number;
  fetchedAt: string;
  readOnly: boolean;
  truncated: boolean;
}

interface ProjectValidationResponse {
  projects: ProjectValidationRow[];
  meta: ProjectValidationMeta;
}

// How stale (ms) before health turns amber/red
const AMBER_THRESHOLD_MS = 60 * 60 * 1000;  // 1 hour
const RED_THRESHOLD_MS   = 24 * 60 * 60 * 1000; // 24 hours

function syncHealthColor(lastSyncedAt: string | null, hasErrors: boolean): "green" | "amber" | "red" {
  if (hasErrors) return "red";
  if (!lastSyncedAt) return "amber";
  const age = Date.now() - new Date(lastSyncedAt).getTime();
  if (age > RED_THRESHOLD_MS) return "red";
  if (age > AMBER_THRESHOLD_MS) return "amber";
  return "green";
}

function HealthDot({ color }: { color: "green" | "amber" | "red" }) {
  const cls =
    color === "green"
      ? "bg-green-500"
      : color === "amber"
      ? "bg-amber-500"
      : "bg-red-500";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />;
}

function directionLabel(direction: string): string {
  if (direction === "crm_to_procore") return "CRM → Procore";
  if (direction === "procore_to_crm") return "Procore → CRM";
  return "Bidirectional";
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    synced:   "bg-green-100 text-green-800",
    pending:  "bg-gray-100 text-gray-700",
    conflict: "bg-amber-100 text-amber-800",
    error:    "bg-red-100 text-red-800",
  };
  return (
    <Badge className={`text-xs ${map[status] ?? "bg-gray-100 text-gray-700"}`}>
      {status}
    </Badge>
  );
}

function ValidationStatusBadge({
  status,
}: {
  status: ProjectValidationRow["status"];
}) {
  const map: Record<ProjectValidationRow["status"], string> = {
    matched: "bg-green-100 text-green-800",
    ambiguous: "bg-amber-100 text-amber-800",
    unmatched: "bg-slate-100 text-slate-700",
  };

  return <Badge className={`text-xs capitalize ${map[status]}`}>{status}</Badge>;
}

function formatProjectLocation(project: ProjectValidationProject) {
  const cityState = [project.city, project.state].filter(Boolean).join(", ");
  return project.address ?? cityState ?? "No location";
}

function formatDealLabel(deal: ProjectValidationDeal | null) {
  if (!deal) {
    return "No CRM deal";
  }

  const name = deal.name ?? "Untitled CRM deal";
  const number = deal.dealNumber ? ` (${deal.dealNumber})` : "";
  return `${name}${number}`;
}

export function ProcoreSyncPage() {
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [procoreStatus, setProcoreStatus] = useState<ProcoreAuthStatus | null>(null);
  const [validationData, setValidationData] = useState<ProjectValidationResponse | null>(null);
  const [validationLoading, setValidationLoading] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  const loadSyncStatus = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<SyncStatusResponse>("/procore/sync-status");
      setData(result);
    } catch (err) {
      console.error("Failed to load sync status:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadValidation = useCallback(async () => {
    setValidationLoading(true);
    try {
      setValidationError(null);
      const result = await api<ProjectValidationResponse>("/procore/project-validation");
      setValidationData(result);
    } catch (err) {
      console.error("Failed to load project validation:", err);
      setValidationError(
        err instanceof Error ? err.message : "Failed to load Procore project validation"
      );
    } finally {
      setValidationLoading(false);
    }
  }, []);

  const loadProcoreStatus = useCallback(async () => {
    setValidationLoading(true);
    try {
      const result = await api<ProcoreAuthStatus>("/auth/procore/status");
      setProcoreStatus(result);
    } catch (err) {
      console.error("Failed to load Procore auth status:", err);
      setProcoreStatus(null);
      setValidationError(
        err instanceof Error ? err.message : "Failed to load Procore auth status"
      );
      setValidationLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    await Promise.all([loadSyncStatus(), loadProcoreStatus()]);
  }, [loadSyncStatus, loadProcoreStatus]);

  const validationSectionState = buildProcoreValidationSectionState({
    status: procoreStatus,
    searchParams,
  });
  const { shouldLoadValidation, connectionBanner, redirectBanner } = validationSectionState;

  useEffect(() => {
    loadSyncStatus();
    loadProcoreStatus();
  }, [loadSyncStatus, loadProcoreStatus]);

  useEffect(() => {
    if (shouldLoadValidation) {
      loadValidation();
    } else if (procoreStatus) {
      setValidationData(null);
      setValidationError(null);
      setValidationLoading(false);
    }
  }, [procoreStatus, shouldLoadValidation, loadValidation]);

  const connectProcore = async () => {
    try {
      const result = await api<{ url: string | null; message?: string | null }>("/auth/procore/url");
      if (!result.url) {
        setValidationError(result.message ?? "Procore auth is not available in this environment");
        setValidationLoading(false);
        return;
      }

      window.location.href = result.url;
    } catch (err) {
      console.error("Failed to start Procore auth:", err);
      setValidationError(
        err instanceof Error ? err.message : "Failed to start Procore auth"
      );
      setValidationLoading(false);
    }
  };

  const disconnectProcore = async () => {
    try {
      await api("/auth/procore/disconnect", { method: "POST" });
      await loadProcoreStatus();
      setValidationData(null);
      setValidationError(null);
    } catch (err) {
      console.error("Failed to disconnect Procore:", err);
      setValidationError(
        err instanceof Error ? err.message : "Failed to disconnect Procore"
      );
      setValidationLoading(false);
    }
  };

  const resolveConflict = async (id: string, resolution: "accept_crm" | "accept_procore") => {
    setResolving(id);
    try {
      await api(`/procore/sync-conflicts/${id}/resolve`, {
        method: "POST",
        json: { resolution },
      });
      await load();
    } catch (err) {
      console.error("Failed to resolve conflict:", err);
    } finally {
      setResolving(null);
    }
  };

  const circuitColor =
    data?.circuit_breaker.state === "closed"
      ? "text-green-600"
      : data?.circuit_breaker.state === "open"
      ? "text-red-600"
      : "text-amber-600";

  const healthColor = data
    ? syncHealthColor(data.lastSyncedAt, data.summary.error > 0)
    : "amber";

  const healthLabel =
    healthColor === "green" ? "Healthy" : healthColor === "amber" ? "Warning" : "Degraded";
  const validationSummary = buildValidationSummary(validationData?.projects ?? []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Zap className="h-6 w-6 text-amber-500" />
            Procore Sync Status
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor sync state, resolve conflicts, and check circuit breaker health
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            Read-Only Project Validation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {redirectBanner ? (
            <div
              className={`rounded-md border p-3 text-sm ${
                redirectBanner.tone === "success"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              <div className="space-y-1">
                <p className="font-medium">{redirectBanner.title}</p>
                <p>{redirectBanner.description}</p>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <p>
                This compares live Procore projects to CRM deals without writing to Procore or
                mutating CRM sync state.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {validationData?.meta.readOnly ? (
                  <Badge className="w-fit bg-blue-100 text-blue-800">Read-only mode</Badge>
                ) : null}
                {procoreStatus?.connected ? (
                  <Badge className="w-fit bg-green-100 text-green-800">Procore connected</Badge>
                ) : null}
              </div>
              {procoreStatus?.connected && (procoreStatus.accountName || procoreStatus.accountEmail) ? (
                <p className="text-xs text-muted-foreground">
                  Connected as {procoreStatus.accountName ?? procoreStatus.accountEmail}
                </p>
              ) : null}
            </div>
            {procoreStatus?.connected ? (
              <Button variant="outline" size="sm" onClick={disconnectProcore}>
                Disconnect Procore
              </Button>
            ) : connectionBanner?.actionLabel ? (
              <Button size="sm" onClick={connectProcore}>
                {connectionBanner?.actionLabel ?? "Connect Procore"}
              </Button>
            ) : null}
          </div>

          {connectionBanner ? (
            <div
              className={`rounded-md border p-3 text-sm ${
                connectionBanner.tone === "destructive"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">{connectionBanner.title}</p>
                  <p>{connectionBanner.description}</p>
                </div>
              </div>
            </div>
          ) : null}

          {validationLoading ? (
            <div className="text-sm text-muted-foreground">Loading project validation...</div>
          ) : validationError ? (
            <div className="text-sm text-red-600">{validationError}</div>
          ) : validationData ? (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-muted-foreground uppercase">
                      Projects
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-slate-900">{validationSummary.total}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-muted-foreground uppercase">
                      Matched
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-green-600">
                      {validationSummary.matched}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-muted-foreground uppercase">
                      Ambiguous
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-amber-600">
                      {validationSummary.ambiguous}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-muted-foreground uppercase">
                      Unmatched
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-slate-600">
                      {validationSummary.unmatched}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="flex flex-col gap-1 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
                <span>
                  Fetched {validationData.meta.fetchedCount} project
                  {validationData.meta.fetchedCount === 1 ? "" : "s"} from company{" "}
                  {validationData.meta.companyId} at{" "}
                  {new Date(validationData.meta.fetchedAt).toLocaleString()}.
                </span>
                {validationData.meta.truncated ? (
                  <span className="text-amber-700">Results were truncated at the safety cap.</span>
                ) : null}
              </div>

              {validationData.projects.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Procore Project</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Match Reason</TableHead>
                      <TableHead>CRM Deal</TableHead>
                      <TableHead>Location</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validationData.projects.map((row) => (
                      <TableRow key={row.project.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-gray-900">
                              {row.project.name ?? "Untitled Procore project"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {row.project.projectNumber ? `${row.project.projectNumber} · ` : ""}
                              ID {row.project.id}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <ValidationStatusBadge status={row.status} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatValidationMatchReason(row.matchReason)}
                        </TableCell>
                        <TableCell className="text-sm">{formatDealLabel(row.deal)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatProjectLocation(row.project)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No Procore projects were returned for validation.
                </div>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      {data && (
        <>
          {/* Sync Health card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Sync Health
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <HealthDot color={healthColor} />
                <span
                  className={`font-semibold text-sm ${
                    healthColor === "green"
                      ? "text-green-700"
                      : healthColor === "amber"
                      ? "text-amber-700"
                      : "text-red-700"
                  }`}
                >
                  {healthLabel}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {data.lastSyncedAt ? (
                  <span>
                    Last synced{" "}
                    <span className="font-medium text-gray-700">
                      {new Date(data.lastSyncedAt).toLocaleString()}
                    </span>
                  </span>
                ) : (
                  <span>No successful syncs recorded</span>
                )}
              </div>
              {data.summary.error > 0 && (
                <div className="flex items-center gap-1.5 text-sm text-red-600">
                  <XCircle className="h-3.5 w-3.5" />
                  {data.summary.error} error{data.summary.error !== 1 ? "s" : ""}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground uppercase">Synced</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">{data.summary.synced}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground uppercase">Pending</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-gray-600">{data.summary.pending}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground uppercase">Conflicts</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-amber-600">{data.summary.conflict}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground uppercase">Errors</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">{data.summary.error}</div>
              </CardContent>
            </Card>
          </div>

          {/* Circuit breaker */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                Circuit Breaker
                <Badge className={`text-xs ${
                  data.circuit_breaker.state === "closed"
                    ? "bg-green-100 text-green-800"
                    : data.circuit_breaker.state === "open"
                    ? "bg-red-100 text-red-800"
                    : "bg-amber-100 text-amber-800"
                }`}>
                  {data.circuit_breaker.state}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <span className={circuitColor}>
                {data.circuit_breaker.failures} consecutive failure{data.circuit_breaker.failures !== 1 ? "s" : ""}
              </span>
              {data.circuit_breaker.openedAt && (
                <span className="ml-2">
                  (opened {new Date(data.circuit_breaker.openedAt).toLocaleString()})
                </span>
              )}
            </CardContent>
          </Card>

          {/* Recent Sync Activity */}
          <div>
            <h2 className="text-lg font-medium text-gray-900 mb-3 flex items-center gap-2">
              <Activity className="h-5 w-5 text-gray-500" />
              Recent Sync Activity
            </h2>
            {data.recentActivity.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity</TableHead>
                    <TableHead>Procore ID</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentActivity.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Badge className="bg-gray-100 text-gray-700 text-xs">
                          {row.entityType}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{row.procoreId}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {directionLabel(row.syncDirection)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={row.syncStatus} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[220px] truncate">
                        {row.errorMessage ?? (row.syncStatus === "synced" ? "OK" : "--")}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {new Date(row.updatedAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No sync activity recorded yet
                </CardContent>
              </Card>
            )}
          </div>

          {/* Conflicts table */}
          {data.conflicts.length > 0 && (
            <div>
              <h2 className="text-lg font-medium text-gray-900 mb-3 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Sync Conflicts ({data.conflicts.length})
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity</TableHead>
                    <TableHead>Procore ID</TableHead>
                    <TableHead>CRM Entity</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.conflicts.map((conflict) => (
                    <TableRow key={conflict.id}>
                      <TableCell>
                        <Badge className="bg-amber-100 text-amber-800 text-xs">
                          {conflict.entityType}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {conflict.procoreId}
                      </TableCell>
                      <TableCell className="text-sm">
                        {conflict.crmEntityType} / {conflict.crmEntityId.slice(0, 8)}...
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {conflict.errorMessage ??
                          (conflict.conflictData
                            ? JSON.stringify(conflict.conflictData).slice(0, 80)
                            : "--")}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(conflict.updatedAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-blue-700 hover:bg-blue-50"
                            disabled={resolving === conflict.id}
                            onClick={() => resolveConflict(conflict.id, "accept_crm")}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                            Keep CRM
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-amber-700 hover:bg-amber-50"
                            disabled={resolving === conflict.id}
                            onClick={() => resolveConflict(conflict.id, "accept_procore")}
                          >
                            <ExternalLinkIcon className="h-3.5 w-3.5 mr-1" />
                            Keep Procore
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {data.conflicts.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                No sync conflicts
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
