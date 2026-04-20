import { PageHeader } from "@/components/layout/page-header";
import { useSalesReview } from "@/hooks/use-sales-review";

export function PipelineHygienePage() {
  const { data, loading, error } = useSalesReview();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pipeline"
        title="Pipeline Hygiene"
        description="Actionable queue of stale and incomplete pipeline records."
      />
      {loading ? <div className="text-sm text-muted-foreground">Loading hygiene queue...</div> : null}
      {error ? <div className="text-sm text-red-600">{error}</div> : null}
      <div className="space-y-3">
        {data?.hygiene.map((row) => (
          <div key={`${row.entityType}-${row.id}`} className="rounded-lg border bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium">{row.name}</p>
                <p className="text-xs text-muted-foreground">{row.assignedRepName} • {row.entityType} • {row.stageId}</p>
              </div>
              <a
                className="text-sm font-medium text-brand-red hover:underline"
                href={row.entityType === "deal" ? `/deals/${row.id}` : `/leads/${row.id}`}
              >
                Open
              </a>
            </div>
            <p className="mt-2 text-sm text-red-600">{row.issueTypes.join(", ")}</p>
          </div>
        ))}
        {data && data.hygiene.length === 0 ? <div className="text-sm text-muted-foreground">No hygiene issues detected.</div> : null}
      </div>
    </div>
  );
}
