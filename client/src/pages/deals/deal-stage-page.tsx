import { Navigate, useParams } from "react-router-dom";
import { useDealStagePage } from "@/hooks/use-deals";
import { useNormalizedStageRoute } from "@/lib/pipeline-scope";
import { PipelineStagePageHeader } from "@/components/pipeline/pipeline-stage-page-header";
import { PipelineStageTable } from "@/components/pipeline/pipeline-stage-table";

export function DealStagePage() {
  const { stageId } = useParams();
  const route = useNormalizedStageRoute("deals", stageId!);
  const { data, loading, error } = useDealStagePage({ stageId: stageId!, ...route.query });

  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  if (error) return <div className="text-sm text-rose-600">{error}</div>;
  if (loading || !data) return <div className="text-sm text-slate-500">Loading stage...</div>;

  return (
    <PipelineStagePageHeader
      backTo={route.backTo}
      title={data.stage.name}
      subtitle={`${data.summary.count} deal${data.summary.count === 1 ? "" : "s"} in this stage`}
    >
      <PipelineStageTable
        rows={data.rows}
        columns={[
          { key: "name", header: "Deal", render: (row) => row.name },
          { key: "dealNumber", header: "Number", render: (row) => row.dealNumber },
          { key: "workflowRoute", header: "Workflow", render: (row) => row.workflowRoute },
          { key: "updatedAt", header: "Updated", render: (row) => new Date(row.updatedAt).toLocaleDateString() },
        ]}
        pagination={data.pagination}
        onPageChange={route.onPageChange}
      />
    </PipelineStagePageHeader>
  );
}
