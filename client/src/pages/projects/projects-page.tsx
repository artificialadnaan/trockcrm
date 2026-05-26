import { Link } from "react-router-dom";
import { Building2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  usePortfolioProjectBoard,
  type PortfolioProjectBoardColumn,
  type PortfolioProjectSummary,
} from "@/hooks/use-projects";

function formatCurrency(value: number | null | undefined) {
  if (value == null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatSyncDate(value: string | null | undefined) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function isStaleValueSync(value: string | null | undefined) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000;
}

function ProjectCard({ project }: { project: PortfolioProjectSummary }) {
  const formattedValue = formatCurrency(project.totalValue);
  const syncDate = formatSyncDate(project.valueSyncedAt);
  const stale = isStaleValueSync(project.valueSyncedAt);

  return (
    <Link
      to={`/projects/${project.id}`}
      className="group block rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-brand-red/40 hover:bg-brand-red/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
    >
      <p className="font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {project.projectNumber ?? "No project #"}
      </p>
      <h3 className="mt-1 line-clamp-2 text-sm font-black leading-5 text-slate-950">
        {project.name}
      </h3>
      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
          Contract Value
        </p>
        <p className="mt-1 text-sm font-black tabular-nums text-slate-950">
          {formattedValue ?? "--"}
        </p>
        {syncDate ? (
          <p className={cn(
            "mt-1 text-[11px] font-bold",
            stale ? "text-amber-700" : "text-slate-500"
          )}>
            {stale ? "Stale value as of " : "As of "}
            {syncDate}
          </p>
        ) : (
          <p className="mt-1 text-[11px] font-bold text-slate-500">Value not synced</p>
        )}
      </div>
    </Link>
  );
}

function StageColumn({ column }: { column: PortfolioProjectBoardColumn }) {
  return (
    <section
      className="flex h-full min-h-[32rem] w-[20rem] shrink-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
      aria-label={`${column.label} projects`}
    >
      <div className="border-b border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
              {column.label}
            </p>
            <p className="mt-2 text-3xl font-black tabular-nums text-slate-950">
              {column.projects.length}
            </p>
          </div>
          <span className="rounded-full bg-brand-red px-2.5 py-0.5 text-xs font-black text-white">
            Portfolio
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {column.projects.length > 0 ? (
          column.projects.map((project) => <ProjectCard key={project.id} project={project} />)
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm font-semibold text-slate-500">
            No projects in this stage.
          </div>
        )}
      </div>
    </section>
  );
}

export function ProjectsPage() {
  const { stages, projects, loading, error, refetch } = usePortfolioProjectBoard();

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-red">
            Procore Portfolio
          </p>
          <h1 className="mt-2 flex items-center gap-3 text-4xl font-black uppercase leading-none tracking-tight text-slate-950">
            <Building2 className="h-8 w-8 text-brand-red" />
            Projects
          </h1>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </section>

      <section
        className="relative flex h-[min(74vh,58rem)] min-h-[42rem] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
        aria-label="Projects kanban board"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
            <Building2 className="h-4 w-4 text-brand-red" />
            Portfolio board
          </div>
          <span className="text-xs font-bold text-slate-500">
            {projects.length} {projects.length === 1 ? "project" : "projects"}
          </span>
        </div>

        {loading ? (
          <div className="p-6 text-sm font-semibold text-slate-500">Loading projects...</div>
        ) : error ? (
          <div className="p-6 text-sm font-semibold text-red-700">{error}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div className="flex h-full gap-3 p-4" style={{ minWidth: "max-content" }}>
              {stages.map((column) => (
                <StageColumn key={column.stage} column={column} />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
