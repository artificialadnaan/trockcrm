import { Navigate, useParams } from "react-router-dom";
import { useDealStagePage } from "@/hooks/use-deals";
import { formatCurrencyCompact } from "@/lib/deal-utils";
import { buildDealStageSummary } from "@/lib/pipeline-stage-summary";
import { useNormalizedStageRoute } from "@/lib/pipeline-scope";
import { PipelineStagePageHeader } from "@/components/pipeline/pipeline-stage-page-header";
import { PipelineStageTable } from "@/components/pipeline/pipeline-stage-table";

export function DealStagePage() {
  const { stageId } = useParams();
  const route = useNormalizedStageRoute("deals", stageId!);
  const { data, loading, error } = useDealStagePage({ stageId: stageId!, ...route.query });
  const summary = buildDealStageSummary(data);

  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  if (error) return <div className="text-sm text-rose-600">{error}</div>;
  if (loading || !data) return <div className="text-sm text-slate-500">Loading stage...</div>;

  return (
    <PipelineStagePageHeader
      backTo={route.backTo}
      title={data.stage.name}
      subtitle={`${data.summary.count} deal${data.summary.count === 1 ? "" : "s"} in this stage`}
      summary={
        <>
          <SummaryMetric label="Records in stage" value={String(summary.totalCount)} />
          <SummaryMetric label="Stage value" value={formatCompactValue(summary.totalValue)} />
          <SummaryMetric label="Avg. visible age" value={`${summary.averageAgeDays} days`} />
        </>
      }
    >
      <PipelineStageTable
        rows={data.rows}
        columns={[
          {
            key: "name",
            header: "Deal",
            render: (row) => (
              <div className="space-y-1">
                <p className="font-semibold text-slate-950">{row.name}</p>
                <p className="text-xs text-slate-500">
                  {[row.propertyCity, row.propertyState].filter(Boolean).join(", ") || "--"}
                </p>
              </div>
            ),
          },
          {
            key: "dealNumber",
            header: "Number",
            render: (row) => (
              <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">
                {row.dealNumber}
              </span>
            ),
          },
          {
            key: "workflowRoute",
            header: "Workflow",
            render: (row) => (
              <span className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
                {row.workflowRoute ?? "--"}
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

function formatCompactValue(value: number) {
  return formatCurrencyCompact(value).replace(".0", "");
}
