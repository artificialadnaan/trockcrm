import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertTriangle, CheckCircle2, XCircle, Zap } from "lucide-react";
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

interface CircuitBreaker {
  state: "closed" | "open" | "half_open";
  failures: number;
  openedAt: number | null;
}

interface SyncStatusResponse {
  summary: SyncSummary;
  conflicts: SyncConflict[];
  circuit_breaker: CircuitBreaker;
}

export function ProcoreSyncPage() {
  const [data, setData] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
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

  useEffect(() => {
    load();
  }, [load]);

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

      {data && (
        <>
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
