import { useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Calendar, Mail, Phone, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { USD_COMPACT } from "@/components/shared/formatters";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useAuth } from "@/lib/auth";
import {
  LEAD_BOARD_STAGE_SLUGS,
  getLeadBoardStageLabel,
  type LeadBoardCard,
  type LeadBoardStage,
  type LeadRecord,
  useLeadBoard,
  useLeads,
} from "@/hooks/use-leads";
import { useKeepPreviousData } from "@/hooks/use-keep-previous-data";
import { useProjectTypes } from "@/hooks/use-pipeline-config";
import { containNonDealsScope, type PipelineScope } from "@/lib/pipeline-scope";
import { cn } from "@/lib/utils";
import { resolvePreferredScope, writeStoredScopePreference } from "@/lib/scope-preferences";
import { LeadsListSection } from "@/components/leads/leads-list-section";
import { LEAD_LIST_SORT_OPTIONS, LEAD_STATUS_OPTIONS } from "@/components/leads/leads-filterbar-adapter";
import type { FilterDimension } from "@/components/filters/filter-bar";

// Shared FilterBar dimensions for the leads list (Wave 1). No Value (leads carry no value), no
// Workflow/Region (leads have neither), no Stalled (flag-gated like deals); Status uses the lead variant.
const LEAD_LIST_FILTERBAR_DIMENSIONS: FilterDimension[] = [
  "search",
  "date",
  "stage",
  "sort",
  "rep",
  "status",
  "projectType",
];

// Team scope is parked (PR #512) and not configured anywhere, so it is not offered here
// -- only Mine | All (mirrors the director dashboard). The shared PipelineScope union still
// includes "team" for URL coercion (see LeadListPage); do not change it.
const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
] as const satisfies readonly ScopeToggleOption<PipelineScope>[];

const SOURCE_LABELS = ["Referral", "Inbound", "Outbound", "Bid Board", "Repeat"] as const;

export function buildLeadIntakePath(leadId: string) {
  return `/leads/${leadId}?focus=qualification`;
}

export function buildLeadStageNavigationPath(
  stageId: string,
  scope: PipelineScope,
  assignedRepId?: string | null,
  search?: string | null
) {
  const params = new URLSearchParams({ scope });
  if (scope !== "mine" && assignedRepId) params.set("assignedRepId", assignedRepId);
  if (search?.trim()) params.set("search", search);
  return `/leads/stages/${stageId}?${params.toString()}`;
}

export function isImmediateNextStageMove(
  currentStageId: string,
  targetStageId: string,
  nextStageById: Map<string, string | null>
) {
  return nextStageById.get(currentStageId) === targetStageId;
}

function getScope(searchParams: URLSearchParams, role: string | undefined): PipelineScope {
  void role;
  const scope = searchParams.get("scope");
  if (scope === "mine" || scope === "team" || scope === "all") return scope;
  return "mine";
}

function matchesLeadBucket(bucket: string | null, slug: string) {
  if (!bucket) return true;
  if (bucket === "lead") {
    return ["lead_new", "company_pre_qualified", "scoping_in_progress", "new_lead"].includes(slug);
  }
  if (bucket === "qualified_lead") {
    return ["pre_qual_value_assigned", "lead_go_no_go", "qualified_lead"].includes(slug);
  }
  if (bucket === "opportunity") {
    return ["qualified_for_opportunity", "sales_validation_stage"].includes(slug);
  }
  return true;
}

function getInitials(name: string | null | undefined) {
  if (!name) return "TR";
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function daysInStage(value: string) {
  const entered = new Date(value).getTime();
  if (Number.isNaN(entered)) return 0;
  return Math.max(0, Math.floor((Date.now() - entered) / 86400000));
}

function leadValue(lead: LeadRecord) {
  return Number(lead.qualificationBudgetAmount ?? lead.forecastRevenue ?? 0);
}

function sourceLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function renderDescriptionPreview(description: string | null | undefined) {
  const value = description?.trim() ?? "";
  if (!value) {
    return <span className="text-xs font-medium text-slate-400">—</span>;
  }

  return (
    <span
      className="group relative block w-full max-w-full outline-none"
      tabIndex={0}
      aria-label={value}
      title={value}
    >
      <span className="block truncate text-xs font-medium text-slate-500">{value}</span>
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden max-w-sm rounded-md border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md ring-1 ring-foreground/10 group-hover:block group-focus:block">
        {value}
      </span>
    </span>
  );
}

function LeadCard({ lead, onOpen }: { lead: LeadBoardCard; onOpen: (id: string) => void }) {
  const location = [lead.propertyCity, lead.propertyState].filter(Boolean).join(", ");
  const age = daysInStage(lead.stageEnteredAt);

  return (
    <button
      type="button"
      onClick={() => onOpen(lead.id)}
      className="group w-full rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors hover:border-brand-red/40 hover:bg-brand-red/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm font-black leading-5 text-slate-950">{lead.name}</p>
          <p className="mt-1 truncate text-xs font-semibold text-slate-500">{lead.companyName ?? "Company pending"}</p>
        </div>
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-blue-700 ring-1 ring-blue-200">
          {sourceLabel(lead.source)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-slate-500">
        <span>{age}d in stage</span>
        {location ? <span>{location}</span> : null}
        <span>{lead.status ?? "open"}</span>
      </div>
    </button>
  );
}

function LeadColumn({
  stage,
  count,
  cards,
  onOpenStage,
  onOpenRecord,
}: {
  stage: LeadBoardStage;
  count: number;
  cards: LeadBoardCard[];
  onOpenStage: (stageId: string) => void;
  onOpenRecord: (leadId: string) => void;
}) {
  const label =
    LEAD_BOARD_STAGE_SLUGS.includes(stage.slug as (typeof LEAD_BOARD_STAGE_SLUGS)[number])
      ? getLeadBoardStageLabel(stage.slug as (typeof LEAD_BOARD_STAGE_SLUGS)[number])
      : stage.name;

  return (
    <section
      className="flex h-full min-h-[32rem] w-[20rem] shrink-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
      aria-label={`${label} leads`}
      tabIndex={0}
    >
      <div className="border-b border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
              {label}
            </p>
            <p className="mt-2 text-3xl font-black tabular-nums text-slate-950">{count}</p>
          </div>
          <span className="rounded-full bg-blue-600 px-2.5 py-0.5 text-xs font-black text-white">
            Active
          </span>
        </div>
        <button
          type="button"
          onClick={() => onOpenStage(stage.id)}
          className="mt-3 inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500 hover:text-brand-red"
        >
          Open stage <ArrowRight className="h-3 w-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {cards.length > 0 ? (
          cards.map((lead) => <LeadCard key={lead.id} lead={lead} onOpen={onOpenRecord} />)
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm font-semibold text-slate-500">
            No leads in this stage.
          </div>
        )}
      </div>
    </section>
  );
}

export function LeadListPage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading || !user) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
        Loading lead board...
      </div>
    );
  }

  return <LeadListPageContent role={user.role} userId={user.id} />;
}

function LeadListPageContent({ role, userId }: { role: string; userId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedScope = resolvePreferredScope({
    requestedScope: searchParams.get("scope"),
    userId,
    fallback: getScope(searchParams, role),
  });
  // Team is not offered (see SCOPE_OPTIONS); coerce a stored/URL ?scope=team to a scope we
  // actually render so the toggle and board never reach the dead "team" placeholder state.
  // Leads offer Mine|All only; coerce the parked "team" and the deals-only "watched" (carried via the
  // shared per-user scope preference) to "mine" — leads has no watched filter (contained to deals).
  const scope = containNonDealsScope(requestedScope);
  // A parked ?scope=team bookmark is coerced to mine for this render; also rewrite the URL so
  // the stale scope/owner params do not persist and silently re-apply when switching scope (D-12b).
  useEffect(() => {
    if (requestedScope !== "team" && requestedScope !== "watched") return;
    const next = new URLSearchParams(searchParams);
    next.set("scope", "mine");
    next.delete("assignedRepId");
    setSearchParams(next, { replace: true });
  }, [requestedScope, searchParams, setSearchParams]);
  const scopeOptions = SCOPE_OPTIONS;
  const bucket = searchParams.get("bucket");
  const search = searchParams.get("search") ?? "";
  const selectedOwnerId = role === "rep" || scope === "mine" ? "" : searchParams.get("assignedRepId") ?? "";
  const { assignees } = useTaskAssignees();
  const { projectTypes } = useProjectTypes();
  const selectedOwnerLabel = selectedOwnerId
    ? assignees.find((assignee) => assignee.id === selectedOwnerId)?.displayName ?? "Selected rep"
    : "All reps";
  // No-blank: keep the previously-loaded board visible during a search/scope refetch (the
  // hook already retains data + sequences responses via its requestId guard; this gates the
  // skeleton to the FIRST load only and surfaces an "Updating..." hint on a refresh).
  const { board: rawBoard, loading, error } = useLeadBoard(scope, selectedOwnerId || undefined, search || undefined);
  const { data: board, isInitialLoading, isRefreshing } = useKeepPreviousData(rawBoard, loading, error);
  const { leads } = useLeads({
    status: "open",
    isActive: true,
    scope,
    ...(search ? { search } : {}),
    ...(selectedOwnerId ? { assignedRepId: selectedOwnerId } : {}),
  });

  const columns = useMemo(
    () =>
      (board?.columns ?? [])
        .filter((column) =>
          LEAD_BOARD_STAGE_SLUGS.includes(column.stage.slug as (typeof LEAD_BOARD_STAGE_SLUGS)[number])
        )
        .filter((column) => matchesLeadBucket(bucket, column.stage.slug)),
    [board?.columns, bucket]
  );
  const activeLeadCount = columns.reduce((sum, column) => sum + column.count, 0);
  const estimatedValue = leads.reduce((sum, lead) => sum + leadValue(lead), 0);
  const staleLeadCount = columns.reduce(
    (sum, column) => sum + column.cards.filter((lead) => daysInStage(lead.stageEnteredAt) > 10).length,
    0
  );
  const sourceCounts = SOURCE_LABELS.map((source) => ({
    source,
    count: leads.filter((lead) => sourceLabel(lead.source).toLowerCase() === source.toLowerCase()).length,
  }));

  const updateScope = (nextScope: PipelineScope) => {
    writeStoredScopePreference(userId, nextScope);
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    if (nextScope === "mine") next.delete("assignedRepId");
    setSearchParams(next);
  };

  const updateOwner = (ownerId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (!ownerId || ownerId === "__all__") next.delete("assignedRepId");
    else next.set("assignedRepId", ownerId);
    setSearchParams(next);
  };

  const updateSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set("search", value);
    else next.delete("search");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-red">
            Workflow control
          </p>
          <h1 className="mt-2 text-4xl font-black uppercase leading-none tracking-tight text-slate-950">
            Leads
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-medium text-slate-500">
            Read-only lead board using canonical CRM-owned stages. Opportunity is excluded from this view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ScopeToggle options={scopeOptions} value={scope} onChange={updateScope} ariaLabel="Lead scope" />
          {(role === "admin" || role === "director") && scope !== "mine" ? (
            <Select value={selectedOwnerId || "__all__"} onValueChange={updateOwner}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="All reps">{selectedOwnerLabel}</SelectValue>
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
          ) : null}
          <Button onClick={() => navigate("/leads/new")} className="bg-brand-red text-white hover:bg-brand-red/90">
            <Plus className="mr-2 h-4 w-4" />
            New Lead
          </Button>
        </div>
      </section>

      <>
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard eyebrow="Active leads" value={String(activeLeadCount)} badge={`${columns.length} stages`} caption="CRM owned" tone="blue" accent="blue" />
        <MetricCard eyebrow="Estimated value" value={USD_COMPACT(estimatedValue)} badge="Open leads" caption="Qualification" tone="green" accent="green" />
        <MetricCard eyebrow="Stale leads" value={String(staleLeadCount)} badge="10d+" caption="Needs touch" tone={staleLeadCount > 0 ? "red" : "white"} accent="red" />
      </div>

      <label className="block max-w-xl space-y-2">
        <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
        <SearchInput value={search} onChange={updateSearch} placeholder="Search leads" aria-label="Search leads" />
      </label>

      {error ? (
        <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
          {error}
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
            <Search className="h-4 w-4 text-brand-red" />
            Source mix
            {isRefreshing ? <span className="font-bold normal-case tracking-normal text-slate-400">· Updating...</span> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {sourceCounts.map((item) => (
              <span key={item.source} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                {item.source} <span className="tabular-nums text-slate-950">{item.count}</span>
              </span>
            ))}
          </div>
        </div>
        {isInitialLoading ? (
          <div className="p-6 text-sm font-semibold text-slate-500">Loading lead board...</div>
        ) : (
          <div className="overflow-x-auto p-4">
            <div className="flex min-w-max gap-4">
              {columns.map((column) => (
                <LeadColumn
                  key={column.stage.id}
                  stage={column.stage}
                  count={column.count}
                  cards={column.cards}
                  onOpenStage={(stageId) =>
                    navigate(buildLeadStageNavigationPath(stageId, scope, selectedOwnerId, search))
                  }
                  onOpenRecord={(leadId) => navigate(`/leads/${leadId}`)}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Wave 1: the shared FilterBar on the full leads list (supersedes the old "Recent open leads"
          preview). URL-backed, lead-adapted dimensions; scope is inherited from the page toggle.
          Filtering/pagination connect when BLUE's lead-date-scope + page/limit land server-side. */}
      <LeadsListSection
        scope={scope}
        filterBar={{
          // Mirror the page's owner-filter gating: the Rep dimension is only useful to admins/directors
          // on a non-"mine" scope (a rep viewing "mine" sees only their own leads).
          dimensions:
            (role === "admin" || role === "director") && scope !== "mine"
              ? LEAD_LIST_FILTERBAR_DIMENSIONS
              : LEAD_LIST_FILTERBAR_DIMENSIONS.filter((dimension) => dimension !== "rep"),
          options: {
            reps: assignees.map((assignee) => ({ value: assignee.id, label: assignee.displayName })),
            projectTypes: projectTypes.map((projectType) => ({ value: projectType.id, label: projectType.name })),
            stages: (board?.columns ?? [])
              .filter((column) =>
                LEAD_BOARD_STAGE_SLUGS.includes(column.stage.slug as (typeof LEAD_BOARD_STAGE_SLUGS)[number])
              )
              .map((column) => ({ value: column.stage.id, label: column.stage.name })),
            sortOptions: LEAD_LIST_SORT_OPTIONS,
            statusOptions: LEAD_STATUS_OPTIONS,
            // Leads are always assigned (non-null assignedRepId) — no "Unassigned" bucket (Codex #577 P1).
            allowUnassigned: false,
          },
        }}
      />
      </>
    </div>
  );
}
