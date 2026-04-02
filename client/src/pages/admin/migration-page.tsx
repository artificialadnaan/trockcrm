import { useState } from "react";
import { useMigrationSummary, type ImportRun } from "@/hooks/use-migration";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  RefreshCw,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Database,
} from "lucide-react";
import { api } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  rolled_back: "bg-amber-100 text-amber-800",
};

const STATUS_ICONS: Record<string, typeof CheckCircle2> = {
  completed: CheckCircle2,
  failed: XCircle,
  running: Clock,
  rolled_back: XCircle,
};

const ENTITY_STATUS_COLORS: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  promoted: "bg-purple-100 text-purple-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  duplicate: "bg-orange-100 text-orange-800",
  rejected: "bg-gray-100 text-gray-800",
  pending: "bg-gray-100 text-gray-600",
};

function RunRow({ run }: { run: ImportRun }) {
  const [showStats, setShowStats] = useState(false);
  const StatusIcon = STATUS_ICONS[run.status] ?? Clock;

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-2">
            <StatusIcon className={`h-4 w-4 ${run.status === "completed" ? "text-green-500" : run.status === "failed" || run.status === "rolled_back" ? "text-red-500" : "text-amber-500"}`} />
            <span className="font-medium text-sm capitalize">{run.type}</span>
          </div>
        </TableCell>
        <TableCell>
          <Badge className={`text-xs ${STATUS_COLORS[run.status] ?? "bg-gray-100"}`}>
            {run.status}
          </Badge>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
          {new Date(run.startedAt).toLocaleString()}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
          {run.completedAt ? new Date(run.completedAt).toLocaleString() : "--"}
        </TableCell>
        <TableCell>
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => setShowStats(!showStats)}>
            {showStats ? "Hide" : "Details"}
          </Button>
        </TableCell>
      </TableRow>
      {showStats && (
        <TableRow>
          <TableCell colSpan={5} className="bg-gray-50">
            <div className="text-xs space-y-1 py-1">
              {run.errorLog && (
                <div className="text-red-600 font-mono whitespace-pre-wrap">{run.errorLog}</div>
              )}
              {Object.keys(run.stats).length > 0 && (
                <pre className="font-mono text-gray-600 whitespace-pre-wrap">
                  {JSON.stringify(run.stats, null, 2)}
                </pre>
              )}
              {!run.errorLog && Object.keys(run.stats).length === 0 && (
                <span className="text-muted-foreground">No additional details</span>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function StatBlock({ label, stats }: { label: string; stats: Record<string, number> }) {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-muted-foreground uppercase">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-gray-900 mb-2">{total.toLocaleString()}</div>
        <div className="space-y-1">
          {Object.entries(stats).map(([status, count]) => (
            <div key={status} className="flex items-center justify-between text-xs">
              <Badge className={`text-[10px] ${ENTITY_STATUS_COLORS[status] ?? "bg-gray-100"}`}>
                {status.replace(/_/g, " ")}
              </Badge>
              <span className="font-medium text-gray-700">{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function MigrationPage() {
  const { summary, loading, error, refetch, runValidation } = useMigrationSummary();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleExtract = async () => {
    setActionLoading("extract");
    try {
      await api("/migration/extract", { method: "POST" });
      await refetch();
    } catch (err) {
      console.error("Extract failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleValidate = async () => {
    setActionLoading("validate");
    try {
      await runValidation();
    } finally {
      setActionLoading(null);
    }
  };

  const handlePromote = async () => {
    if (!window.confirm("Promote all approved records to production tables? This action cannot be undone.")) return;
    setActionLoading("promote");
    try {
      await api("/migration/promote", { method: "POST" });
      await refetch();
    } catch (err) {
      console.error("Promote failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Database className="h-6 w-6 text-purple-500" />
            Data Migration
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Extract, validate, and promote HubSpot data
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-red-800 text-sm">{error}</div>
      )}

      {/* Action buttons */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Migration Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={handleExtract}
              disabled={actionLoading != null}
            >
              <Play className="h-4 w-4 mr-1" />
              {actionLoading === "extract" ? "Extracting..." : "Extract"}
            </Button>
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={handleValidate}
              disabled={actionLoading != null}
            >
              <Play className="h-4 w-4 mr-1" />
              {actionLoading === "validate" ? "Validating..." : "Validate"}
            </Button>
            <Button
              size="sm"
              className="bg-purple-600 hover:bg-purple-700 text-white"
              onClick={handlePromote}
              disabled={actionLoading != null}
            >
              <Play className="h-4 w-4 mr-1" />
              {actionLoading === "promote" ? "Promoting..." : "Promote"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Pipeline: Extract from HubSpot, then Validate staged data, then Promote approved records.
          </p>
        </CardContent>
      </Card>

      {/* Stats */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatBlock label="Deals" stats={summary.deals} />
          <StatBlock label="Contacts" stats={summary.contacts} />
          <StatBlock label="Activities" stats={summary.activities} />
        </div>
      )}

      {/* Recent runs */}
      {summary?.recentRuns && summary.recentRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent Import Runs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.recentRuns.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {summary && (!summary.recentRuns || summary.recentRuns.length === 0) && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            No import runs yet. Click Extract to begin.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
