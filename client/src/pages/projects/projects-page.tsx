import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpDown, Building2, CalendarDays, CircleDollarSign, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/deal-utils";
import { useSalesReps } from "@/hooks/use-sales-reps";
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

const ALL_VALUE = "__all__";
const TERMINAL_PHASES = ["post-construction", "post construction", "warranty", "complete", "completed"];

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatMoney(value: string | null | undefined) {
  if (value == null) return "--";
  return formatCurrency(value);
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

function isTerminalPhase(phaseName: string | null | undefined) {
  const normalized = (phaseName ?? "").trim().toLowerCase();
  return TERMINAL_PHASES.includes(normalized);
}

function phaseTone(index: number, phaseName: string) {
  if (isTerminalPhase(phaseName)) return "border-slate-300 bg-slate-50 text-slate-700";
  return index % 2 === 0
    ? "border-red-200 bg-red-50 text-red-800"
    : "border-amber-200 bg-amber-50 text-amber-800";
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const phaseDays = daysSince(project.lastSyncedAt);
  return (
    <Link
      to={`/projects/${project.id}`}
      className="block rounded-md border border-slate-200 bg-white p-3 shadow-sm transition hover:border-brand-red hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {project.procoreProjectNumber ?? "No project #"}
        </span>
        <span className="text-xs text-muted-foreground">
          {phaseDays == null ? "--" : `${phaseDays}d`}
        </span>
      </div>
      <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-foreground">{project.name}</h3>
      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-600">
            {(project.projectOwnerName ?? "U").slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate">{project.projectOwnerName ?? "No owner"}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate">{addressLabel(project)}</span>
          <span className="font-medium text-foreground">{formatMoney(project.contractValue)}</span>
        </div>
      </div>
      {isTerminalPhase(project.currentPhaseName) ? (
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
          <span>Complete: {formatDate(project.completionDate)}</span>
          <span>Finish: {formatDate(project.projectedFinishDate)}</span>
        </div>
      ) : null}
    </Link>
  );
}

export function ProjectsPage() {
  const [phaseGroups, setPhaseGroups] = useState<ProjectPhaseGroup[]>([]);
  const [listData, setListData] = useState<ProjectsListResponse | null>(null);
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

    try {
      const [byPhase, list] = await Promise.all([
        api<{ phases: ProjectPhaseGroup[] }>(`/projects/by-phase?${params.toString()}`),
        api<ProjectsListResponse>(`/projects?${params.toString()}`),
      ]);
      setPhaseGroups(byPhase.phases);
      setListData(list);
    } catch (error) {
      console.error("Failed to load Procore projects:", error);
      setPhaseGroups([]);
      setListData(null);
    } finally {
      setLoading(false);
    }
  }, [completionTo, owner, page, perPage, phase, search, sortBy, sortOrder, startFrom]);

  useEffect(() => {
    load();
  }, [load]);

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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Building2 className="h-6 w-6 text-brand-red" />
            <h1 className="text-2xl font-semibold text-foreground">Projects</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Active and completed projects in Procore Portfolio.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white p-3">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
        <span className="text-sm text-muted-foreground">{totalProjects} projects</span>
      </div>

      {loading ? (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center text-sm text-muted-foreground">
          Loading projects...
        </div>
      ) : phaseGroups.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center text-sm text-muted-foreground">
          No Procore projects mirrored yet. Run the admin backfill after deployment.
        </div>
      ) : (
        <section className="overflow-x-auto pb-2">
          <div className="flex min-h-[420px] gap-4">
            {phaseGroups.map((group, index) => (
              <div
                key={group.phaseId}
                className="flex w-[320px] shrink-0 flex-col rounded-md border border-slate-200 bg-slate-50"
              >
                <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-3">
                  <Badge variant="outline" className={phaseTone(index, group.phaseName)}>
                    {group.phaseName}
                  </Badge>
                  <span className="text-sm font-medium text-muted-foreground">{group.count}</span>
                </div>
                <div className="max-h-[620px] flex-1 space-y-3 overflow-y-auto p-3">
                  {group.projects.map((project) => (
                    <ProjectCard key={project.id} project={project} />
                  ))}
                  {group.overflowCount > 0 ? (
                    <div className="rounded-md border border-dashed border-slate-300 p-3 text-center text-xs text-muted-foreground">
                      +{group.overflowCount} more in list view
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-md border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Project List</h2>
            <p className="text-xs text-muted-foreground">Paginated mirror of Procore Portfolio projects.</p>
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
                ["owner", "Owner"],
                ["contractValue", "Contract Value"],
                ["startDate", "Start Date"],
                ["completionDate", "Completion Date"],
                ["lastSyncedAt", "Last Synced"],
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
            {(listData?.projects ?? []).map((project) => (
              <TableRow key={project.id} className="cursor-pointer">
                <TableCell className="font-mono text-sm">
                  <Link to={`/projects/${project.id}`} className="text-brand-red hover:underline">
                    {project.procoreProjectNumber ?? "--"}
                  </Link>
                </TableCell>
                <TableCell className="max-w-xs font-medium">
                  <Link to={`/projects/${project.id}`} className="line-clamp-1 hover:underline">
                    {project.name}
                  </Link>
                </TableCell>
                <TableCell>{project.currentPhaseName ?? "Unassigned"}</TableCell>
                <TableCell>{project.projectOwnerName ?? "No owner"}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <CircleDollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                    {formatMoney(project.contractValue)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                    {formatDate(project.startDate)}
                  </span>
                </TableCell>
                <TableCell>{formatDate(project.completionDate)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(project.lastSyncedAt)}</TableCell>
              </TableRow>
            ))}
            {!loading && (listData?.projects ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  No projects match the current filters.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-muted-foreground">
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
