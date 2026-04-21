import { useState } from "react";
import { RefreshCw, ClipboardList, ExternalLink, Pencil } from "lucide-react";
import { Link } from "react-router-dom";
import { useMyCleanupQueue } from "@/hooks/use-ownership-cleanup";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MyCleanupDealEditorDialog } from "./my-cleanup-deal-editor-dialog";

function formatTimestamp(value: string | null) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function MyCleanupPage() {
  const { rows, total, loading, error, refetch } = useMyCleanupQueue();
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);

  const dealEditorOpen = selectedDealId !== null;
  const openDealEditor = (dealId: string) => setSelectedDealId(dealId);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-amber-700" />
            <h1 className="text-2xl font-semibold">My Cleanup</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Active records you own that still need enrichment or follow-up context.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card className="border-amber-200 bg-amber-50/40">
        <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-900">{total.toLocaleString()} open cleanup items</p>
            <p className="text-sm text-muted-foreground">
              These items will disappear automatically once the underlying record is fixed.
            </p>
          </div>
          <Link to="/" className="text-sm font-semibold text-amber-800 hover:text-amber-900">
            Back to dashboard
          </Link>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-red-700">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Queue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading cleanup queue...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cleanup work is currently assigned to you.</p>
          ) : (
            rows.map((row) => (
              <article
                key={`${row.recordType}:${row.recordId}`}
                className={`rounded-lg border bg-white p-4 ${row.recordType === "deal" ? "cursor-pointer transition-colors hover:border-amber-300 hover:bg-amber-50/30" : ""}`}
                onClick={row.recordType === "deal" ? () => openDealEditor(row.recordId) : undefined}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-slate-900">{row.recordName}</h3>
                      <Badge variant="secondary">{row.recordType}</Badge>
                      <Badge variant="outline">{row.severity}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {row.companyName ?? "No company"} {row.stageName ? `· ${row.stageName}` : ""}
                    </p>
                    <p className="text-sm text-slate-700">
                      Reason: <span className="font-medium">{row.reasonCode.replace(/_/g, " ")}</span>
                    </p>
                  </div>
                  <div className="text-sm text-muted-foreground sm:text-right">
                    <p>Assigned to: {row.assignedUserName ?? "Unassigned"}</p>
                    <p>Evaluated: {formatTimestamp(row.evaluatedAt)}</p>
                    <p>Generated: {formatTimestamp(row.generatedAt)}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {row.recordType === "deal" ? (
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 gap-2 px-2.5 text-[0.8rem]"
                      onClick={(event) => {
                        event.stopPropagation();
                        openDealEditor(row.recordId);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      Edit Deal
                    </Button>
                  ) : (
                    <Link
                      to={`/leads/${row.recordId}`}
                      className="inline-flex h-7 items-center justify-center gap-2 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open Lead
                    </Link>
                  )}
                </div>
              </article>
            ))
          )}
        </CardContent>
      </Card>

      <MyCleanupDealEditorDialog
        key={selectedDealId ?? "closed"}
        dealId={selectedDealId}
        open={dealEditorOpen}
        onOpenChange={(open) => {
          if (!open) setSelectedDealId(null);
        }}
        onSaved={() => {
          void refetch();
        }}
      />
    </div>
  );
}
