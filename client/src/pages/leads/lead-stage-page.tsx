import { Navigate, useParams } from "react-router-dom";
import { useLeadStagePage } from "@/hooks/use-leads";
import { buildLeadStageSummary } from "@/lib/pipeline-stage-summary";
import { useNormalizedStageRoute } from "@/lib/pipeline-scope";
import { PipelineStagePageHeader } from "@/components/pipeline/pipeline-stage-page-header";
import { PipelineStageTable } from "@/components/pipeline/pipeline-stage-table";

export function LeadStagePage() {
  const { stageId } = useParams();
  const route = useNormalizedStageRoute("leads", stageId!);
  const { data, loading, error } = useLeadStagePage({ stageId: stageId!, ...route.query });
  const summary = buildLeadStageSummary(data);

  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  if (error) return <div className="text-sm text-rose-600">{error}</div>;
  if (loading || !data) return <div className="text-sm text-slate-500">Loading stage...</div>;

  return (
    <PipelineStagePageHeader
      backTo={route.backTo}
      title={data.stage.name}
      subtitle={`${data.summary.count} lead${data.summary.count === 1 ? "" : "s"} in this stage`}
      summary={
        <>
          <SummaryMetric label="Records in stage" value={String(summary.totalCount)} />
          <SummaryMetric label="Avg. visible age" value={`${summary.averageAgeDays} days`} />
          <SummaryMetric
            label={summary.isOpportunityStage ? "Opportunity stage" : "Qualified pressure"}
            value={summary.isQualifiedPressureStage ? "Yes" : "No"}
          />
        </>
      }
    >
      <PipelineStageTable
        rows={data.rows}
        columns={[
          {
            key: "name",
            header: "Lead",
            render: (row) => (
              <div className="space-y-1">
                <p className="font-semibold text-slate-950">{row.name}</p>
                <p className="text-xs text-slate-500">
                  {[row.propertyCity, row.propertyState].filter(Boolean).join(", ") || row.companyName || "--"}
                </p>
              </div>
            ),
          },
          {
            key: "companyName",
            header: "Company",
            render: (row) => row.companyName ?? "--",
          },
          {
            key: "source",
            header: "Source",
            render: (row) => (
              <span className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
                {row.source ?? "--"}
              </span>
            ),
          },
          {
            key: "updatedAt",
            header: "Updated",
            render: (row) => new Date(row.updatedAt).toLocaleDateString(),
          },
        ]}
        pagination={data.pagination}
        onPageChange={route.onPageChange}
      />
    </PipelineStagePageHeader>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-black tracking-[0.18em] text-slate-500 uppercase">{label}</p>
      <p className="text-[2rem] leading-none font-black tracking-tight text-slate-950">{value}</p>
    </div>
  );
}
