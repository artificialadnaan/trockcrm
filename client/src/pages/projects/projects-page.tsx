import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpDown,
  Briefcase,
  Building2,
  CircleDollarSign,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MetricCard } from "@/components/shared/metric-card";
import { USD_COMPACT } from "@/components/shared/formatters";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/deal-utils";
import { useSalesReps } from "@/hooks/use-sales-reps";
import { cn } from "@/lib/utils";
import type { ProjectPhaseGroup, ProjectSummary } from "@/hooks/use-projects";

interface ProjectsListResponse {
  projects: ProjectSummary[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

interface ProjectCounts {
  active: number;
  inactive: number;
  total: number;
}

const ALL_VALUE = "__all__";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatMoney(value: string | null | undefined) {
  if (value == null) return "--";
  return formatCurrency(value);
}

function moneyValue(project: ProjectSummary) {
  return Number(project.contractValue ?? project.estimatedValue ?? 0) || 0;
}

function addressLabel(project: ProjectSummary) {
  const parts = [project.address.city, project.address.state].filter(Boolean);
  return parts.length ? parts.join(", ") : "No address";
}

function daysSince(value: string | null | undefined) {
  if (!value) return null;
  const start = new Date(value).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((Date.now() - start) / 86_400_000));
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const ageDays = daysSince(project.lastSyncedAt);
  const inactive = project.isActive === false;

  return (
    <Link
      to={`/projects/${project.id}`}
      className={cn(
        "group block w-full rounded-lg border bg-white p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
        inactive
          ? "border-slate-200 bg-slate-50/70 opacity-75 hover:border-slate-300"
          : "border-slate-200 hover:border-brand-red/40 hover:bg-brand-red/[0.03]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {project.procoreProjectNumber ?? "No project #"}
          </p>
          <p className={cn(
            "mt-1 line-clamp-2 text-sm font-black leading-5",
            inactive ? "text-slate-600" : "text-slate-950"
          )}>
            {project.name}
          </p>
        </div>
        {inactive ? (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-700 ring-1 ring-slate-300">
            Inactive
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
            Active
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="flex size-5 items-center justify-center rounded-full bg-slate-100 text-[9px] font-black text-slate-600">
            {(project.projectOwnerName ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate">{project.projectOwnerName ?? "No owner"}</span>
        </span>
        <span className="truncate">{addressLabel(project)}</span>
        {ageDays != null ? <span>{ageDays}d synced</span> : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span className="font-bold text-slate-600">{project.currentPhaseName ?? "Unassigned"}</span>
        <span className="font-black tabular-nums text-slate-950">{formatMoney(project.contractValue)}</span>
      </div>
    </Link>
  );
}

function PhaseColumn({
  group,
  inactiveMode,
}: {
  group: ProjectPhaseGroup;
  inactiveMode: boolean;
}) {
  return (
    <section
      className="flex h-full min-h-[32rem] w-[22rem] shrink-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
      aria-label={`${group.phaseName} projects`}
      tabIndex={0}
    >
      <div className="border-b border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
              {group.phaseName}
            </p>
            <p className="mt-2 text-3xl font-black tabular-nums text-slate-950">{group.count}</p>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-black text-white",
              inactiveMode ? "bg-slate-500" : "bg-brand-red"
            )}
          >
            {inactiveMode ? "Mixed" : "Active"}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {group.projects.length > 0 ? (
          group.projects.map((project) => <ProjectCard key={project.id} project={project} />)
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm font-semibold text-slate-500">
            No projects in this phase.
          </div>
        )}
        {group.overflowCount > 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-3 text-center text-[11px] font-bold text-slate-500">
            +{group.overflowCount} more in list view
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function ProjectsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const includeInactive = searchParams.get("include_inactive") === "true";

  const [phaseGroups, setPhaseGroups] = useState<ProjectPhaseGroup[]>([]);
  const [listData, setListData] = useState<ProjectsListResponse | null>(null);
  const [counts, setCounts] = useState<ProjectCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [phase, setPhase] = useState(ALL_VALUE);
  const [owner, setOwner] = useState(ALL_VALUE);
  const [startFrom, setStartFrom] = useState("");
  const [completionTo, setCompletionTo] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [sortBy, setSortBy] = useState("phase");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const { salesReps } = useSalesReps();

  // Toggling the Active / Include-inactive segment must reset pagination —
  // page 5 of the inactive list has no equivalent page 5 in the active-only
  // list (~7 pages vs ~16), so preserving the page index yields an empty
  // table that looks like data loss. Mirrors the setPage(1) pattern used
  // by the other filter setters below.
  const setIncludeInactive = (next: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (next) {
      params.set("include_inactive", "true");
    } else {
      params.delete("include_inactive");
    }
    setSearchParams(params);
    setPage(1);
  };

  const phaseOptions = useMemo(
    () => phaseGroups.map((group) => ({ id: group.phaseId, name: group.phaseName })),
    [phaseGroups]
  );

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      sortBy,
      sortOrder,
    });
    if (search.trim()) params.set("search", search.trim());
    if (phase !== ALL_VALUE) params.set("phase", phase);
    if (owner !== ALL_VALUE) params.set("assigned_owner", owner);
    if (startFrom) params.set("start_from", startFrom);
    if (completionTo) params.set("completion_to", completionTo);
    if (includeInactive) params.set("include_inactive", "true");

    try {
      // Counts powers the Active/Inactive metric cards only — a failure
      // here must not take down the Kanban or list. Catch inline so the
      // primary calls can still resolve; metric cards fall back to the
      // "—" placeholder when counts is null.
      const [byPhase, list, countsResp] = await Promise.all([
        api<{ phases: ProjectPhaseGroup[] }>(`/projects/by-phase?${params.toString()}`),
        api<ProjectsListResponse>(`/projects?${params.toString()}`),
        api<ProjectCounts>(`/projects/counts`).catch((err) => {
          console.warn("Failed to load project counts; continuing without:", err);
          return null;
        }),
      ]);
      setPhaseGroups(byPhase.phases);
      setListData(list);
      setCounts(countsResp);
    } catch (error) {
      console.error("Failed to load Procore projects:", error);
      setPhaseGroups([]);
      setListData(null);
      setCounts(null);
    } finally {
      setLoading(false);
    }
  }, [completionTo, includeInactive, owner, page, perPage, phase, search, sortBy, sortOrder, startFrom]);

  useEffect(() => {
    load();
  }, [load]);

  const visibleProjects = listData?.projects ?? [];
  const totalContract = useMemo(
    () => visibleProjects.reduce((sum, project) => sum + moneyValue(project), 0),
    [visibleProjects]
  );
  const totalProjects = listData?.pagination.total ?? 0;

  function setSort(nextSortBy: string) {
    if (nextSortBy === sortBy) {
      setSortOrder((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(nextSortBy);
      setSortOrder("asc");
    }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-red">
            Portfolio mirror
          </p>
          <h1 className="mt-2 flex items-center gap-3 text-4xl font-black uppercase leading-none tracking-tight text-slate-950">
            <Building2 className="h-8 w-8 text-brand-red" />
            Projects
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-medium text-slate-500">
            Read-only board over the Procore Portfolio mirror. Active projects show by default; toggle to include inactive.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5 text-xs font-black uppercase tracking-wide">
            <button
              type="button"
              aria-pressed={!includeInactive}
              onClick={() => setIncludeInactive(false)}
              className={cn(
                "rounded-full px-3 py-1 transition-colors",
                !includeInactive ? "bg-brand-red text-white" : "text-slate-500 hover:text-slate-900"
              )}
            >
              Active only
            </button>
            <button
              type="button"
              aria-pressed={includeInactive}
              onClick={() => setIncludeInactive(true)}
              className={cn(
                "rounded-full px-3 py-1 transition-colors",
                includeInactive ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"
              )}
            >
              Include inactive
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          eyebrow="Active projects"
          value={counts ? String(counts.active) : "—"}
          badge={counts ? `of ${counts.total} mirrored` : "Counts unavailable"}
          caption="CRM-wide, unfiltered"
          tone="white"
          accent="red"
        />
        <MetricCard
          eyebrow="Inactive"
          value={counts ? String(counts.inactive) : "—"}
          badge={counts ? (includeInactive ? "Shown in views" : "Hidden by default") : "Counts unavailable"}
          caption="CRM-wide, unfiltered"
          tone="white"
          accent="slate"
        />
        <MetricCard
          eyebrow="Contract value"
          value={USD_COMPACT(totalContract)}
          badge={`${totalProjects} on page`}
          caption="Sum of visible rows"
          tone="green"
          accent="green"
        />
      </div>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-3">
          <div className="relative min-w-64 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search project number or name"
              className="pl-9"
            />
          </div>
          <Select value={phase} onValueChange={(value) => { setPhase(value ?? ALL_VALUE); setPage(1); }}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All phases" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All phases</SelectItem>
              {phaseOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={owner} onValueChange={(value) => { setOwner(value ?? ALL_VALUE); setPage(1); }}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All owners" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All owners</SelectItem>
              {salesReps.map((rep) => (
                <SelectItem key={rep.id} value={rep.id}>
                  {rep.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            aria-label="Start date filter"
            className="w-40"
            value={startFrom}
            onChange={(event) => {
              setStartFrom(event.target.value);
              setPage(1);
            }}
          />
          <Input
            type="date"
            aria-label="Completion date filter"
            className="w-40"
            value={completionTo}
            onChange={(event) => {
              setCompletionTo(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </section>

      <section
        className="relative flex h-[min(72vh,56rem)] min-h-[42rem] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
        aria-label="Projects kanban board"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
          <Briefcase className="h-4 w-4 text-brand-red" />
          Kanban board
          <ArrowRight className="ml-1 h-3 w-3 text-slate-400" />
          <span className="text-slate-500">Click a card to open detail</span>
        </div>
        {loading ? (
          <div className="p-6 text-sm font-semibold text-slate-500">Loading project board...</div>
        ) : phaseGroups.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">
            No projects match the current filters.
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div className="flex h-full gap-3 p-4" style={{ minWidth: "max-content" }}>
              {phaseGroups.map((group) => (
                <PhaseColumn key={group.phaseId} group={group} inactiveMode={includeInactive} />
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Project list</p>
            <p className="mt-1 text-xs font-medium text-slate-500">
              {totalProjects} {totalProjects === 1 ? "project" : "projects"} on page
            </p>
          </div>
          <Select value={String(perPage)} onValueChange={(value) => { setPerPage(Number(value ?? 25)); setPage(1); }}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[25, 50, 100].map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              {[
                ["projectNumber", "Project Number"],
                ["name", "Name"],
                ["phase", "Phase"],
                ["status", "Status"],
                ["owner", "Owner"],
                ["contractValue", "Contract"],
                ["startDate", "Start"],
                ["completionDate", "Completion"],
                ["lastSyncedAt", "Last synced"],
              ].map(([key, label]) => (
                <TableHead key={key}>
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => setSort(key)}>
                    {label}
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleProjects.map((project) => {
              const inactive = project.isActive === false;
              return (
                <TableRow
                  key={project.id}
                  className={cn("cursor-pointer", inactive && "bg-slate-50 text-slate-500")}
                >
                  <TableCell className="font-mono text-sm">
                    <Link to={`/projects/${project.id}`} className={cn(inactive ? "" : "text-brand-red", "hover:underline")}>
                      {project.procoreProjectNumber ?? "--"}
                    </Link>
                  </TableCell>
                  <TableCell className={cn("max-w-xs font-medium", inactive && "line-through decoration-slate-300")}>
                    <Link to={`/projects/${project.id}`} className="line-clamp-1 hover:underline">
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell>{project.currentPhaseName ?? "Unassigned"}</TableCell>
                  <TableCell>
                    {inactive ? (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-700 ring-1 ring-slate-300">
                        Inactive
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
                        Active
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{project.projectOwnerName ?? "No owner"}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      <CircleDollarSign className="h-3.5 w-3.5 text-slate-400" />
                      {formatMoney(project.contractValue)}
                    </span>
                  </TableCell>
                  <TableCell>{formatDate(project.startDate)}</TableCell>
                  <TableCell>{formatDate(project.completionDate)}</TableCell>
                  <TableCell className="text-slate-500">{formatDate(project.lastSyncedAt)}</TableCell>
                </TableRow>
              );
            })}
            {!loading && visibleProjects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-sm text-slate-500">
                  No projects match the current filters.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-500">
          <span>
            Page {listData?.pagination.page ?? page} of {listData?.pagination.totalPages ?? 1}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= (listData?.pagination.totalPages ?? 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
