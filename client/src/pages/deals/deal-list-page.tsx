import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Briefcase, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { USD_COMPACT } from "@/components/shared/formatters";
import { useDealBoard, type Deal, type DealBoardColumn } from "@/hooks/use-deals";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { buildCanonicalDealBoardColumns } from "@/lib/canonical-deal-board";
import { daysInStage } from "@/lib/deal-utils";
import { useAuth } from "@/lib/auth";
import { TerminalDateFilterControl } from "@/components/pipeline/terminal-date-filter-control";
import {
  buildDealStageWorkspacePath,
  getTerminalDateFilterLabel,
  isTerminalOutcomeSlug,
  readTerminalDateFiltersFromSearchParams,
  setTerminalDateFilterSearchParams,
  writeTerminalDateFilter,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import type { PipelineScope } from "@/lib/pipeline-scope";
import { KanbanScrollColumn } from "@/components/deals/kanban-scroll-column";
import { DecoratedKanbanCard } from "@/components/deals/decorated-kanban-card";
import { DealsListSection } from "@/components/deals/deals-list-section";

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

function getScope(searchParams: URLSearchParams, role: string | undefined): PipelineScope {
  if (role === "rep") return "mine";
  const scope = searchParams.get("scope");
  if (scope === "mine" || scope === "team" || scope === "all") return scope;
  if (role === "director") return "team";
  if (role === "admin") return "all";
  return "mine";
}

function readCurrentTerminalDateFilters(): Record<TerminalOutcome, TerminalDateFilter> {
  return {
    won: { preset: "all" },
    lost: { preset: "all" },
  };
}

export function buildDealStageNavigationPath(
  column: DealBoardColumn,
  scope: PipelineScope,
  filters: Record<TerminalOutcome, TerminalDateFilter> = readCurrentTerminalDateFilters()
) {
  return buildDealStageWorkspacePath({
    stageId: column.stage.id,
    stageSlug: column.stage.slug,
    scope,
    filters,
  });
}

function moneyValue(deal: Deal) {
  return Number(deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate ?? 0);
}

function DealsBoardColumn({
  column,
  onOpenStage,
  onOpenRecord,
  terminalFilter,
  onTerminalFilterChange,
}: {
  column: DealBoardColumn;
  onOpenStage: (column: DealBoardColumn) => void;
  onOpenRecord: (id: string) => void;
  terminalFilter?: TerminalDateFilter;
  onTerminalFilterChange?: (filter: TerminalDateFilter) => void;
}) {
  const totalValue =
    column.totalValue ?? column.cards.reduce((sum, deal) => sum + moneyValue(deal), 0);
  const terminalOutcome = isTerminalOutcomeSlug(column.stage.slug) ? column.stage.slug : null;
  const terminalLabel = terminalFilter ? getTerminalDateFilterLabel(terminalFilter) : null;
  const emptyText = terminalOutcome && terminalFilter?.preset !== "all" ? "No deals in selected range" : "No deals";

  const header = (
    <>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="truncate text-left text-xs font-medium uppercase tracking-wide text-gray-500 hover:text-gray-900"
          onClick={() => onOpenStage(column)}
        >
          {column.stage.name}
          {terminalLabel ? <span className="ml-1 text-slate-400">· {terminalLabel}</span> : null}
        </button>
        <span className="rounded-sm bg-gray-200/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-gray-600">
          {column.count}
        </span>
      </div>
      {terminalOutcome && terminalFilter && onTerminalFilterChange ? (
        <TerminalDateFilterControl
          stageName={column.stage.name}
          filter={terminalFilter}
          onFilterChange={onTerminalFilterChange}
          className="mt-2"
          buttonClassName="rounded-sm text-xs"
          inputClassName="rounded-sm text-xs"
        />
      ) : null}
      <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">
        {USD_COMPACT(totalValue)}
      </p>
    </>
  );

  return (
    <KanbanScrollColumn header={header} childCount={column.cards.length}>
      {column.cards.length > 0 ? (
        column.cards.map((deal) => (
          <DecoratedKanbanCard
            key={deal.id}
            deal={deal}
            stageSlug={column.stage.slug}
            slaDays={STAGE_SLA_DAYS[column.stage.slug] ?? 7}
            onClick={() => onOpenRecord(deal.id)}
          />
        ))
      ) : (
        <div className="border border-dashed border-gray-200 py-8 text-center text-xs text-gray-400">
          {emptyText}
        </div>
      )}
    </KanbanScrollColumn>
  );
}

export function DealListPage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading || !user) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
        Loading deal board...
      </div>
    );
  }

  return <DealListPageContent role={user.role} />;
}

function DealListPageContent({ role }: { role: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [terminalDateFilters, setTerminalDateFilters] = useState<Record<TerminalOutcome, TerminalDateFilter>>(() =>
    readTerminalDateFiltersFromSearchParams(searchParams)
  );
  const scope = getScope(searchParams, role);
  const { board, loading, error } = useDealBoard(scope, true, terminalDateFilters);
  const { stages } = usePipelineStages("deal");

  useEffect(() => {
    setTerminalDateFilters(readTerminalDateFiltersFromSearchParams(searchParams));
  }, [searchParams]);

  const updateTerminalDateFilter = useCallback((outcome: TerminalOutcome, filter: TerminalDateFilter) => {
    writeTerminalDateFilter(outcome, filter);
    setTerminalDateFilters((current) => ({ ...current, [outcome]: filter }));
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      setTerminalDateFilterSearchParams(next, outcome, filter);
      return next;
    });
  }, [setSearchParams]);

  const columns = useMemo(
    () => {
      const searchTerm = search.trim().toLowerCase();
      return buildCanonicalDealBoardColumns(board?.columns, stages)
        .map((column) => {
          if (!searchTerm) return column;
          const cards = column.cards.filter((deal) => {
            const haystack = [
              deal.name,
              deal.dealNumber,
              deal.projectNumber,
              deal.companyName,
              deal.propertyCity,
              deal.propertyState,
              deal.assignedRepName,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return haystack.includes(searchTerm);
          });
          return {
            ...column,
            cards,
            count: cards.length,
            totalValue: cards.reduce((sum, deal) => sum + moneyValue(deal), 0),
          };
        });
    },
    [board?.columns, search, stages]
  );
  const totalCount = columns.reduce((sum, column) => sum + column.count, 0);
  const totalValue = columns.reduce(
    (sum, column) =>
      sum +
      (column.totalValue ?? column.cards.reduce((cardSum, deal) => cardSum + moneyValue(deal), 0)),
    0
  );
  const wonValue =
    board?.terminalStages
      ?.filter((terminal) => terminal.stage.slug === "won")
      .reduce(
        (sum, terminal) => sum + terminal.deals.reduce((dealSum, deal) => dealSum + moneyValue(deal), 0),
        0
      ) ?? 0;
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
    navigate(buildDealStageNavigationPath(column, scope, terminalDateFilters));
  };

  // Synced top scrollbar proxy (matches /pipeline pattern).
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const innerWidthSpacerRef = useRef<HTMLDivElement>(null);
  const isSyncingScrollRef = useRef(false);

  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    const spacer = innerWidthSpacerRef.current;
    if (!main || !spacer) return;
    const sync = () => {
      spacer.style.width = `${main.scrollWidth}px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(main);
    for (const child of Array.from(main.children)) {
      observer.observe(child);
    }
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [columns.length, loading]);

  const handleMainScroll = () => {
    if (isSyncingScrollRef.current) {
      isSyncingScrollRef.current = false;
      return;
    }
    const main = mainScrollRef.current;
    const top = topScrollRef.current;
    if (!main || !top) return;
    if (top.scrollLeft !== main.scrollLeft) {
      isSyncingScrollRef.current = true;
      top.scrollLeft = main.scrollLeft;
    }
  };

  const handleTopScroll = () => {
    if (isSyncingScrollRef.current) {
      isSyncingScrollRef.current = false;
      return;
    }
    const main = mainScrollRef.current;
    const top = topScrollRef.current;
    if (!main || !top) return;
    if (main.scrollLeft !== top.scrollLeft) {
      isSyncingScrollRef.current = true;
      main.scrollLeft = top.scrollLeft;
    }
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
        <MetricCard
          eyebrow="Active pipeline"
          value={USD_COMPACT(totalValue)}
          badge={`${totalCount} deals`}
          caption="Open board"
          tone="white"
          accent="red"
        />
        <MetricCard
          eyebrow="Won"
          value={USD_COMPACT(wonValue)}
          badge="Bid Board"
          caption={getTerminalDateFilterLabel(terminalDateFilters.won)}
          tone="blue"
          accent="blue"
        />
        <MetricCard
          eyebrow="At risk"
          value={String(overSlaCount)}
          badge="Over SLA"
          caption="Needs touch"
          tone={overSlaCount > 0 ? "red" : "green"}
          accent="red"
        />
      </div>

      <label className="block">
        <span className="sr-only">Search deals</span>
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search deals"
            className="pl-9"
          />
        </div>
      </label>

      {error ? (
        <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
          {error}
        </div>
      ) : null}

      <section
        className="relative flex h-[min(72vh,56rem)] min-h-[42rem] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
        aria-label="Deals kanban board"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
          <Briefcase className="h-4 w-4 text-brand-red" />
          Kanban board
          <ArrowRight className="ml-1 h-3 w-3 text-slate-400" />
          <span className="text-slate-500">Click a card to open detail</span>
        </div>
        {loading ? (
          <div className="p-6 text-sm font-semibold text-slate-500">Loading deal board...</div>
        ) : (
          <>
            <div
              ref={topScrollRef}
              onScroll={handleTopScroll}
              className="flex-shrink-0 overflow-x-auto overflow-y-hidden border-b border-slate-100"
              aria-hidden="true"
            >
              <div ref={innerWidthSpacerRef} style={{ height: 1 }} />
            </div>
            <div
              ref={mainScrollRef}
              onScroll={handleMainScroll}
              className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div className="flex h-full gap-3 p-4" style={{ minWidth: "max-content" }}>
                {columns.map((column) => (
                  <DealsBoardColumn
                    key={column.stage.id}
                    column={column}
                    onOpenStage={openStage}
                    onOpenRecord={(id) => navigate(`/deals/${id}`)}
                    terminalFilter={
                      isTerminalOutcomeSlug(column.stage.slug)
                        ? terminalDateFilters[column.stage.slug]
                        : undefined
                    }
                    onTerminalFilterChange={
                      isTerminalOutcomeSlug(column.stage.slug)
                        ? (filter) => updateTerminalDateFilter(column.stage.slug as TerminalOutcome, filter)
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      <DealsListSection
        workflowFamily="deal"
        scope={scope}
        enableExport
        enableDateFilter={false}
        showFilterButton
        pageSize={20}
        searchPlaceholder="Search deals or accounts"
      />
    </div>
  );
}
