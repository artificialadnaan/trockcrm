import { Link } from "react-router-dom";
import { AlertTriangle, Building2, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  usePortfolioProjectBoard,
  type PortfolioProductionRollup,
  type PortfolioProductionRollupGroup,
  type PortfolioProjectBoardColumn,
  type PortfolioProjectSummary,
} from "@/hooks/use-projects";
import { formatCurrency } from "@/lib/deal-utils";

/** Synthetic column key the server uses for projects whose stage matches no board column. */
const UNMAPPED_STAGE = "unmapped";

function titleCaseStage(stage: string) {
  return stage.replace(/\b\w/g, (char) => char.toUpperCase());
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
          {formattedValue}
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

function RollupGroupTile({
  title,
  icon,
  group,
}: {
  title: string;
  icon: React.ReactNode;
  group: PortfolioProductionRollupGroup;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
        {icon}
        {title}
      </div>
      <p className="mt-2 text-2xl font-black tabular-nums text-slate-950">
        {formatCurrency(group.totalValue)}
      </p>
      <p className="mt-1 text-[11px] font-bold text-slate-500">
        {group.projectCount} {group.projectCount === 1 ? "project" : "projects"}
        {" · "}
        {group.stages.map(titleCaseStage).join(", ")}
      </p>
    </div>
  );
}

/**
 * The caveat text, as four distinct statements — because "the total is a floor" is only true
 * when something is MISSING from it.
 *
 * A stale value is present and counted; Procore may since have revised it up or down, so a
 * stale-only roll-up is complete-but-possibly-out-of-date IN EITHER DIRECTION, which is a
 * different claim from understating. Saying "floor" there — and pairing it with "0 projects
 * have no synced value" — asserted two things that were both false.
 */
function rollupCaveat(rollup: PortfolioProductionRollup) {
  const { unsyncedValueCount: missing, staleValueCount: stale, staleAfterDays: days } = rollup;
  const staleClause = (
    <>
      <span className="tabular-nums">{stale}</span>{" "}
      {stale === 1 ? "value was" : "values were"} last synced from Procore more than {days} days
      ago and may have moved in either direction
    </>
  );
  const missingClause = (
    <>
      <span className="tabular-nums">{missing}</span>{" "}
      {missing === 1 ? "project has" : "projects have"} no synced value and
      {missing === 1 ? " counts" : " count"} as $0
    </>
  );

  if (missing > 0 && stale > 0) {
    return { tone: "warn" as const, body: <>Total is a floor, not a final number: {missingClause}; a further {staleClause}.</> };
  }
  if (missing > 0) {
    return { tone: "warn" as const, body: <>Total is a floor, not a final number: {missingClause}.</> };
  }
  if (stale > 0) {
    // Complete, but not necessarily current. Deliberately does NOT say "floor".
    return { tone: "warn" as const, body: <>Every project's value is included, but {staleClause}.</> };
  }
  if (rollup.projectCount === 0) {
    return {
      tone: "calm" as const,
      body: <>No projects are in a construction or service production stage right now.</>,
    };
  }
  return {
    tone: "calm" as const,
    body: (
      <>
        All {rollup.projectCount} {rollup.projectCount === 1 ? "project" : "projects"} have a value
        synced from Procore within the last {days} days.
      </>
    ),
  };
}

/**
 * Production Revenue roll-up.
 *
 * Every dollar here is the sum of the board's OWN stage-column subtotals (the server rolls up
 * column.totalValue, it does not re-sum the rows), so the card and the columns underneath it
 * reconcile by construction.
 *
 * The caveat is not optional decoration: a project with no synced value counts as $0, so the
 * headline can only ever UNDERSTATE. The card says how much of it is unreliable and why.
 */
function ProductionRollupCard({ rollup }: { rollup: PortfolioProductionRollup }) {
  const caveat = rollupCaveat(rollup);
  const hasCaveat = caveat.tone === "warn";

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      aria-label="Production revenue roll-up"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-red">
            Production Revenue
          </p>
          <p className="mt-2 text-4xl font-black tabular-nums leading-none text-slate-950">
            {formatCurrency(rollup.totalValue)}
          </p>
          {/*
            Track-NEUTRAL wording on purpose. This count includes the service stages as well as the
            construction ones (the server rolls both into projectCount and totalValue), so naming only
            "Buy Out, Pre-Construction and In Production" described service revenue as construction-stage
            work — undercutting the split the card exists to show. The tiles below name the exact stages
            per track, so the summary does not need to and must not contradict them.
          */}
          <p className="mt-2 text-[11px] font-bold text-slate-500">
            {rollup.projectCount} {rollup.projectCount === 1 ? "project" : "projects"} across the
            construction and service production stages
          </p>
        </div>
        <div className="grid w-full gap-3 sm:grid-cols-2 lg:max-w-xl">
          <RollupGroupTile
            title="Construction"
            icon={<Building2 className="h-4 w-4 text-brand-red" />}
            group={rollup.construction}
          />
          <RollupGroupTile
            title="Service"
            icon={<Wrench className="h-4 w-4 text-brand-red" />}
            group={rollup.service}
          />
        </div>
      </div>

      <div
        className={cn(
          "mt-4 flex items-start gap-2 rounded-lg border p-3 text-[11px] font-bold",
          hasCaveat
            ? "border-amber-300 bg-amber-50 text-amber-900"
            : "border-slate-200 bg-slate-50 text-slate-600"
        )}
      >
        <AlertTriangle
          className={cn("mt-px h-3.5 w-3.5 shrink-0", hasCaveat ? "text-amber-700" : "text-slate-400")}
        />
        <p>{caveat.body}</p>
      </div>
    </section>
  );
}

function StageColumn({ column }: { column: PortfolioProjectBoardColumn }) {
  const unmapped = column.stage === UNMAPPED_STAGE;

  return (
    <section
      className={cn(
        "flex h-full min-h-[32rem] w-[20rem] shrink-0 flex-col overflow-hidden rounded-lg border",
        unmapped ? "border-amber-300 bg-amber-50/60" : "border-slate-200 bg-slate-50"
      )}
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
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-black text-white",
              unmapped ? "bg-amber-600" : "bg-brand-red"
            )}
          >
            {unmapped ? "Unmapped" : "Portfolio"}
          </span>
        </div>
        {unmapped ? (
          <p className="mt-2 text-[11px] font-bold text-amber-800">
            Stages with no board column of their own. Shown here so no project is ever dropped.
          </p>
        ) : null}
        <div className="mt-3">
          <p className="text-lg font-black tabular-nums text-slate-950">
            {formatCurrency(column.totalValue)}
          </p>
          <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">
            Stage total
          </p>
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
  const { stages, projects, productionRollup, loading, error, refetch } = usePortfolioProjectBoard();

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

      {!loading && !error && productionRollup ? (
        <ProductionRollupCard rollup={productionRollup} />
      ) : null}

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
