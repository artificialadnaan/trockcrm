import { PageHeader } from "@/components/layout/page-header";
import { useSalesReview } from "@/hooks/use-sales-review";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";

function prettifyIssue(issue: string) {
  return issue.replace(/_/g, " ");
}

function prettifyReason(reason: string | null) {
  if (!reason) return null;
  return reason.replace(/_/g, " ");
}

export function PipelineHygienePage() {
  const { user } = useAuth();
  const { data, loading, error } = useSalesReview();
  const isRep = user?.role === "rep";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={isRep ? "Pipeline" : "Sales"}
        title={isRep ? "My Cleanup" : "Pipeline Hygiene"}
        description={
          isRep
            ? "Work through the incomplete records in your book so your forecasts and next steps are trustworthy."
            : "Actionable queue of stale, incomplete, and unassigned pipeline records."
        }
      />
      {loading ? <div className="text-sm text-muted-foreground">Loading hygiene queue...</div> : null}
      {error ? <div className="text-sm text-red-600">{error}</div> : null}
      <div className="space-y-3">
        {data?.hygiene.map((row) => (
          <div key={`${row.entityType}-${row.id}`} className="rounded-lg border bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium">{row.name}</p>
                <p className="text-xs text-muted-foreground">
                  {row.assignedRepName ?? "Unassigned"} • {row.entityType} • {row.stageId}
                </p>
              </div>
              <a
                className="text-sm font-medium text-brand-red hover:underline"
                href={row.entityType === "deal" ? `/deals/${row.id}` : `/leads/${row.id}`}
              >
                Open
              </a>
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
                  <span className="font-medium text-slate-700">Unassigned reason:</span>{" "}
                  {prettifyReason(row.unassignedReasonCode)}
                </p>
              ) : null}
            </div>
          </div>
        ))}
        {data && data.hygiene.length === 0 ? <div className="text-sm text-muted-foreground">No hygiene issues detected.</div> : null}
      </div>
    </div>
  );
}
