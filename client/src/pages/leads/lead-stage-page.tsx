import { Navigate, useParams } from "react-router-dom";
import { useLeadStagePage } from "@/hooks/use-leads";
import { useNormalizedStageRoute } from "@/lib/pipeline-scope";
import { PipelineStagePageHeader } from "@/components/pipeline/pipeline-stage-page-header";
import { PipelineStageTable } from "@/components/pipeline/pipeline-stage-table";

export function LeadStagePage() {
  const { stageId } = useParams();
  const route = useNormalizedStageRoute("leads", stageId!);
  const { data } = useLeadStagePage({ stageId: stageId!, ...route.query });

  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  if (!data) return <div className="text-sm text-slate-500">Loading stage...</div>;

  return (
    <PipelineStagePageHeader
      backTo={route.backTo}
      title={data.stage.name}
      subtitle={`${data.summary.count} lead${data.summary.count === 1 ? "" : "s"} in this stage`}
    >
      <PipelineStageTable
        rows={data.rows}
        columns={[
          { key: "name", header: "Lead", render: (row) => row.name },
          { key: "companyName", header: "Company", render: (row) => row.companyName ?? "--" },
          { key: "source", header: "Source", render: (row) => row.source ?? "--" },
          { key: "updatedAt", header: "Updated", render: (row) => new Date(row.updatedAt).toLocaleDateString() },
        ]}
        pagination={data.pagination}
        onPageChange={route.onPageChange}
      />
    </PipelineStagePageHeader>
  );
}
