import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Briefcase, CalendarClock, Clock, MapPin, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { USD_COMPACT } from "@/components/shared/formatters";
import { useDealBoard, useDeals, type Deal, type DealBoardColumn } from "@/hooks/use-deals";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { buildCanonicalDealBoardColumns } from "@/lib/canonical-deal-board";
import { daysInStage } from "@/lib/deal-utils";
import {
  buildDealStageWorkspacePath,
  readTerminalDateFilter,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import type { PipelineScope } from "@/lib/pipeline-scope";
import { cn } from "@/lib/utils";

const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "team", label: "Team" },
  { value: "all", label: "All" },
] as const satisfies readonly ScopeToggleOption<PipelineScope>[];

const STAGE_SLA_DAYS: Record<string, number> = {
  opportunity: 7,
  estimating: 10,
  service_estimating: 10,
  estimate_under_review: 4,
  estimate_sent_to_client: 7,
  contract: 10,
  won: 0,
  lost: 0,
};

function getScope(searchParams: URLSearchParams): PipelineScope {
  const scope = searchParams.get("scope");
  return scope === "mine" || scope === "team" || scope === "all" ? scope : "mine";
}

function readCurrentTerminalDateFilters(): Record<TerminalOutcome, TerminalDateFilter> {
  return {
    won: readTerminalDateFilter("won"),
    lost: readTerminalDateFilter("lost"),
  };
}

export function buildDealStageNavigationPath(column: DealBoardColumn, scope: PipelineScope) {
  return buildDealStageWorkspacePath({
    stageId: column.stage.id,
    stageSlug: column.stage.slug,
    scope,
    filters: readCurrentTerminalDateFilters(),
  });
}

function moneyValue(deal: Deal) {
  return Number(deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate ?? 0);
}

function locationLine(deal: Deal) {
  return [deal.propertyCity, deal.propertyState].filter(Boolean).join(", ");
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

function formatLastTouch(value: string | null) {
  if (!value) return "No touch";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No touch";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function DealCard({
  deal,
  stageSlug,
  onOpen,
}: {
  deal: Deal;
  stageSlug: string;
  onOpen: (id: string) => void;
}) {
  const age = daysInStage(deal.stageEnteredAt);
  const sla = STAGE_SLA_DAYS[stageSlug] ?? 7;
  const isOverSla = sla > 0 && age > sla;
  const value = moneyValue(deal);
  const location = locationLine(deal);

  return (
    <button
      type="button"
      onClick={() => onOpen(deal.id)}
      className="group w-full rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors hover:border-brand-red/40 hover:bg-brand-red/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">
            {deal.dealNumber}
          </p>
          <p className="mt-1 line-clamp-2 text-sm font-black leading-5 text-slate-950">{deal.name}</p>
        </div>
        {value > 0 ? (
          <p className="shrink-0 text-base font-black tabular-nums text-slate-950">
            {USD_COMPACT(value)}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-red text-[10px] font-black text-white">
          {getInitials(deal.assignedRepName)}
        </span>
        <span className="min-w-0 flex-1 truncate">{deal.companyId ? deal.companyId : "Account pending"}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-slate-500">
        <span className={cn("inline-flex items-center gap-1", isOverSla ? "text-brand-red" : "")}>
          <Clock className="h-3 w-3" />
          {age}d / {sla || "terminal"} SLA
        </span>
        {location ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <MapPin className="h-3 w-3" />
            <span className="truncate">{location}</span>
          </span>
        ) : null}
      </div>
    </button>
  );
}

function BoardColumn({
  column,
  onOpenStage,
  onOpenRecord,
}: {
  column: DealBoardColumn;
  onOpenStage: (column: DealBoardColumn) => void;
  onOpenRecord: (id: string) => void;
}) {
  const totalValue = column.totalValue ?? column.cards.reduce((sum, deal) => sum + moneyValue(deal), 0);

  return (
    <section
      className="flex h-full min-h-[32rem] w-[19rem] shrink-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
      aria-label={`${column.stage.name} deals`}
      tabIndex={0}
    >
      <div className="border-b border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
              {column.stage.name}
            </p>
            <p className="mt-2 text-2xl font-black tabular-nums text-slate-950">
              {USD_COMPACT(totalValue)}
            </p>
          </div>
          <span className="rounded-full bg-brand-red px-2.5 py-0.5 text-xs font-black text-white">
            {column.count}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onOpenStage(column)}
          className="mt-3 inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500 hover:text-brand-red"
        >
          Open stage <ArrowRight className="h-3 w-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {column.cards.length > 0 ? (
          column.cards.map((deal) => (
            <DealCard key={deal.id} deal={deal} stageSlug={column.stage.slug} onOpen={onOpenRecord} />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm font-semibold text-slate-500">
            No deals in this stage.
          </div>
        )}
      </div>
    </section>
  );
}

export function DealListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = getScope(searchParams);
  const { board, loading, error } = useDealBoard(scope, true);
  const { deals } = useDeals({ limit: 200, isActive: true, sortBy: "updated_at", sortDir: "desc" });
  const { stages } = usePipelineStages();

  const columns = useMemo(() => buildCanonicalDealBoardColumns(board?.columns, stages), [board?.columns, stages]);
  const totalCount = columns.reduce((sum, column) => sum + column.count, 0);
  const totalValue = columns.reduce(
    (sum, column) => sum + (column.totalValue ?? column.cards.reduce((cardSum, deal) => cardSum + moneyValue(deal), 0)),
    0
  );
  const wonValue =
    board?.terminalStages
      ?.filter((terminal) => terminal.stage.slug === "won")
      .reduce((sum, terminal) => sum + terminal.deals.reduce((dealSum, deal) => dealSum + moneyValue(deal), 0), 0) ?? 0;
  const overSlaCount = columns.reduce(
    (sum, column) =>
      sum +
      column.cards.filter((deal) => {
        const sla = STAGE_SLA_DAYS[column.stage.slug] ?? 7;
        return sla > 0 && daysInStage(deal.stageEnteredAt) > sla;
      }).length,
    0
  );

  const updateScope = (nextScope: PipelineScope) => {
    const next = new URLSearchParams(searchParams);
    next.set("scope", nextScope);
    setSearchParams(next);
  };

  const openStage = (column: DealBoardColumn) => {
    navigate(buildDealStageNavigationPath(column, scope));
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-red">
            Workflow control
          </p>
          <h1 className="mt-2 text-4xl font-black uppercase leading-none tracking-tight text-slate-950">
            Deals
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-medium text-slate-500">
            Read-only pipeline board over the existing deal stages. Open a card or stage for the working surface.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ScopeToggle options={SCOPE_OPTIONS} value={scope} onChange={updateScope} ariaLabel="Deal scope" />
          <Button onClick={() => navigate("/deals/new")} className="bg-brand-red text-white hover:bg-brand-red/90">
            <Plus className="mr-2 h-4 w-4" />
            New Deal
          </Button>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard eyebrow="Active pipeline" value={USD_COMPACT(totalValue)} badge={`${totalCount} deals`} caption="Open board" tone="white" accent="red" />
        <MetricCard eyebrow="Won YTD" value={USD_COMPACT(wonValue)} badge="Bid Board" caption="Terminal filter" tone="blue" accent="blue" />
        <MetricCard eyebrow="At risk" value={String(overSlaCount)} badge="Over SLA" caption="Needs touch" tone={overSlaCount > 0 ? "red" : "green"} accent="red" />
      </div>

      {error ? (
        <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
          {error}
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
            <Briefcase className="h-4 w-4 text-brand-red" />
            Kanban board
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
            <Search className="h-4 w-4" />
            <span>Use stage workspaces for search and pagination</span>
          </div>
        </div>
        {loading ? (
          <div className="p-6 text-sm font-semibold text-slate-500">Loading deal board...</div>
        ) : (
          <div className="overflow-x-auto p-4">
            <div className="flex min-w-max gap-4">
              {columns.map((column) => (
                <BoardColumn key={column.stage.id} column={column} onOpenStage={openStage} onOpenRecord={(id) => navigate(`/deals/${id}`)} />
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Recent deal movement</p>
          <Link to={`/deals?scope=${scope}`} className="text-xs font-bold text-brand-red">
            {deals.length} visible
          </Link>
        </div>
        <div className="divide-y divide-slate-100">
          {deals.slice(0, 6).map((deal) => (
            <button
              type="button"
              key={deal.id}
              onClick={() => navigate(`/deals/${deal.id}`)}
              className="grid w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 md:grid-cols-[minmax(0,1fr)_160px_120px_120px_24px]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-950">{deal.name}</p>
                <p className="mt-1 truncate text-xs font-semibold text-slate-500">{deal.dealNumber}</p>
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-red text-[10px] font-black text-white">
                  {getInitials(deal.assignedRepName)}
                </span>
                <span className="truncate">{deal.assignedRepName ?? "Unassigned"}</span>
              </div>
              <div className="text-sm font-black tabular-nums text-slate-950">{USD_COMPACT(moneyValue(deal))}</div>
              <div className="flex items-center gap-1 text-xs font-semibold text-slate-500">
                <CalendarClock className="h-3.5 w-3.5" />
                {formatLastTouch(deal.lastActivityAt)}
              </div>
              <ArrowRight className="h-4 w-4 text-slate-400" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
