import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useDealStagePage } from "@/hooks/use-deals";
import { formatCurrencyCompact } from "@/lib/deal-utils";
import { buildDealStageSummary } from "@/lib/pipeline-stage-summary";
import { useNormalizedStageRoute } from "@/lib/pipeline-scope";
import { PipelineStagePageHeader } from "@/components/pipeline/pipeline-stage-page-header";
import { PipelineStageTable } from "@/components/pipeline/pipeline-stage-table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRegions } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useAuth } from "@/lib/auth";
import { getWorkflowRouteLabel } from "@/lib/pipeline-ownership";

export function DealStagePage() {
  const navigate = useNavigate();
  const { stageId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const route = useNormalizedStageRoute("deals", stageId!);
  const { data, loading, error } = useDealStagePage({ stageId: stageId!, ...route.query });
  const { regions } = useRegions();
  const { assignees } = useTaskAssignees();
  const { user } = useAuth();
  const summary = buildDealStageSummary(data);

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("scope", route.query.scope);
    params.set("page", "1");
    if (!value || value === "__all__") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    setSearchParams(params);
  };

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
      <div className="grid gap-3 rounded-[1.5rem] border border-slate-200 bg-white/90 p-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="space-y-2">
          <label className="text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">Search</label>
          <Input
            value={searchParams.get("search") ?? ""}
            onChange={(event) => updateFilter("search", event.target.value)}
            placeholder="Deal, number, city, state"
          />
        </div>
        <div className="space-y-2">
          <label className="text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">Region</label>
          <Select
            value={searchParams.get("regionId") ?? "__all__"}
            onValueChange={(value) => updateFilter("regionId", value ?? "__all__")}
          >
            <SelectTrigger>
              <SelectValue placeholder="All regions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All regions</SelectItem>
              {regions.map((region) => (
                <SelectItem key={region.id} value={region.id}>
                  {region.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {user?.role === "admin" ? (
          <div className="space-y-2">
            <label className="text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">Sales rep</label>
            <Select
              value={searchParams.get("assignedRepId") ?? "__all__"}
              onValueChange={(value) => updateFilter("assignedRepId", value ?? "__all__")}
            >
              <SelectTrigger>
                <SelectValue placeholder="All reps" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All reps</SelectItem>
                {assignees.map((assignee) => (
                  <SelectItem key={assignee.id} value={assignee.id}>
                    {assignee.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-2">
          <label className="text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">Updated after</label>
          <Input
            type="date"
            value={searchParams.get("updatedAfter") ?? ""}
            onChange={(event) => updateFilter("updatedAfter", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">Updated before</label>
          <Input
            type="date"
            value={searchParams.get("updatedBefore") ?? ""}
            onChange={(event) => updateFilter("updatedBefore", event.target.value)}
          />
        </div>
      </div>

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
                {row.workflowRoute ? getWorkflowRouteLabel(row.workflowRoute) : "--"}
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
        onRowClick={(row) => navigate(`/deals/${row.id}`)}
        getRowKey={(row) => row.id}
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
