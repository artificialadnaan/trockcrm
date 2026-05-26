import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Building2, Clock3, ExternalLink, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProjectDetail } from "@/hooks/use-projects";
import { cn } from "@/lib/utils";

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not synced";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatCurrency(value: number | null | undefined) {
  if (value == null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function isStaleValueSync(value: string | null | undefined) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000;
}

function formatStageLabel(value: string | null | undefined) {
  return String(value ?? "Unknown stage")
    .split(" ")
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function formatStageEnteredSummary(stage: string, enteredAt: string | null | undefined) {
  const stageLabel = formatStageLabel(stage);
  if (!enteredAt) return `Entered ${stageLabel}; date not synced`;
  return `Entered ${stageLabel} on ${formatDateTime(enteredAt)}`;
}

function buildProcoreProjectUrl(companyId: string | null | undefined, projectId: string | null | undefined) {
  if (!companyId || !projectId) return null;
  return `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${projectId}/tools/projecthome`;
}

function DetailItem({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-slate-950">{value || "--"}</dd>
    </div>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { project, loading, error } = useProjectDetail(id);

  if (loading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => navigate("/projects")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Projects
        </Button>
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
          Loading project...
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-700">{error ?? "Project not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/projects")}>
          Back to Projects
        </Button>
      </div>
    );
  }

  const procoreProjectUrl = buildProcoreProjectUrl(project.procoreCompanyId, project.procoreProjectId);
  const contractValue = formatCurrency(project.totalValue);
  const valueSyncedDate = formatDate(project.valueSyncedAt);
  const valueSyncIsStale = isStaleValueSync(project.valueSyncedAt);

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => navigate("/projects")}>
        <ArrowLeft className="mr-1 h-4 w-4" />
        Projects
      </Button>

      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-black uppercase leading-tight tracking-tight text-slate-950">
              {project.name}
            </h1>
            <Badge variant="outline" className="border-brand-red/30 bg-brand-red/10 text-brand-red">
              {project.currentStage}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm font-semibold text-slate-500">
            <span className="font-mono">{project.projectNumber ?? "No project #"}</span>
            <span>Procore Portfolio</span>
          </div>
        </div>
        {procoreProjectUrl ? (
          <a
            href={procoreProjectUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            View in Procore
          </a>
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-brand-red" />
              Project References
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-5 sm:grid-cols-2">
              <DetailItem label="Project Number" value={project.projectNumber} />
              <DetailItem label="Current Stage" value={project.currentStage} />
              <DetailItem label="Contract Value" value={contractValue ?? "--"} />
              <div>
                <dt className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                  Value Freshness
                </dt>
                <dd className={cn(
                  "mt-1 text-sm font-semibold",
                  valueSyncIsStale ? "text-amber-700" : "text-slate-950"
                )}>
                  {valueSyncedDate
                    ? `${valueSyncIsStale ? "Stale value as of" : "As of"} ${valueSyncedDate}`
                    : "Value not synced"}
                </dd>
              </div>
              <DetailItem label="Procore Project ID" value={project.procoreProjectId} />
              <DetailItem label="Procore Company ID" value={project.procoreCompanyId} />
              <DetailItem label="First Seen" value={formatDateTime(project.firstSeenAt)} />
              <DetailItem label="Last Updated" value={formatDateTime(project.updatedAt)} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock3 className="h-4 w-4 text-brand-red" />
              Current Stage Timing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-5">
              <DetailItem label="Stage Entered" value={formatDateTime(project.currentStageEnteredAt)} />
              <DetailItem
                label="Latest Stage Change"
                value={formatStageEnteredSummary(project.currentStage, project.currentStageEnteredAt)}
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-brand-red" />
            Stage History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {project.stageHistory.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm font-semibold text-slate-500">
              No stage history has been relayed yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {project.stageHistory.map((entry) => (
                <div key={entry.id} className="grid gap-2 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <p className="text-sm font-black text-slate-950">
                      {entry.previousStage ? `${entry.previousStage} -> ${entry.stage}` : `Entered ${entry.stage}`}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      {entry.isBoardRelevant ? "Board stage" : "Legacy stage"}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-slate-500">{formatDateTime(entry.enteredAt)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
