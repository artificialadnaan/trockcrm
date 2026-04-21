import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, FolderKanban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/deal-utils";
import { useProjectDetail } from "@/hooks/use-projects";

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { project, loading, error } = useProjectDetail(id);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="h-6 w-32 rounded bg-muted animate-pulse" />
          <div className="h-8 w-80 rounded bg-muted animate-pulse" />
          <div className="h-4 w-96 rounded bg-muted animate-pulse" />
        </div>
        <div className="h-40 rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Project not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/projects")}>
          Back to Projects
        </Button>
      </div>
    );
  }

  const procoreProjectUrl = `https://app.procore.com/projects/${project.procore_project_id}`;

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit text-muted-foreground hover:text-foreground"
        onClick={() => navigate("/projects")}
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Projects
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <FolderKanban className="h-4 w-4 text-brand-red" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand-red">
              Project Surface
            </span>
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-black tracking-tight text-foreground">{project.name}</h1>
              <span className="font-mono text-sm text-muted-foreground">{project.deal_number}</span>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Deal-backed project view for the existing Procore-linked record. Project tasks will
              live on this route.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <Badge
              className="border-0 text-xs font-medium text-white"
              style={{ backgroundColor: project.stage_color }}
            >
              {project.stage_name}
            </Badge>
            <span>Project id {project.id}</span>
            {project.change_order_total != null ? (
              <span>{formatCurrency(project.change_order_total)} in change orders</span>
            ) : (
              <span>No change order total yet</span>
            )}
          </div>
        </div>

        <a
          href={procoreProjectUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
        >
          Open in Procore
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <span className="text-sm font-medium text-foreground">Tasks</span>
          <span className="text-xs text-muted-foreground">Initial shell</span>
        </div>
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            This route is reserved for project-scoped task management. The current slice only
            establishes the shell and route ownership for the deal-backed project record.
          </p>
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-muted-foreground">
            No project task data has been wired into this view yet.
          </div>
        </CardContent>
      </div>
    </div>
  );
}
