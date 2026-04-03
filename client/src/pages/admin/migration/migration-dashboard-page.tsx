import { CheckCircle2, AlertTriangle, XCircle, Clock, RefreshCw, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { useMigrationSummary } from "@/hooks/use-migration";
import { useState } from "react";

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

export function MigrationDashboardPage() {
  const { summary, loading, error, refetch, runValidation } = useMigrationSummary();
  const [validating, setValidating] = useState(false);

  const handleValidate = async () => {
    setValidating(true);
    try {
      await runValidation();
    } finally {
      setValidating(false);
    }
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard label="Deals" stats={summary.deals} href="/admin/migration/deals" />
          <StatCard label="Contacts" stats={summary.contacts} href="/admin/migration/contacts" />
          <StatCard label="Activities" stats={summary.activities} />
        </div>
      )}

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
