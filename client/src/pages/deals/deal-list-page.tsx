import { useNavigate } from "react-router-dom";
import {
  Plus,
  Building2,
  MapPin,
  Clock,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { DealFilters } from "@/components/deals/deal-filters";
import { getDealStageMetadata, getWorkflowRouteLabel, useDeals } from "@/hooks/use-deals";
import { useDealFilters } from "@/hooks/use-deal-filters";
import { usePipelineStages, useRegions } from "@/hooks/use-pipeline-config";
import {
  formatCurrency,
  bestEstimate,
  daysInStage,
  timeAgo,
} from "@/lib/deal-utils";

export function DealListPage() {
  const navigate = useNavigate();
  const { filters, setFilters, resetFilters } = useDealFilters();
  const { deals, pagination, loading, error } = useDeals(filters);
  const { stages } = usePipelineStages();
  const { regions } = useRegions();

  const regionNameById = new Map(regions.map((region) => [region.id, region.name]));
  const columns = stages
    .filter((stage) => deals.some((deal) => deal.stageId === stage.id))
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((stage) => {
      const stageDeals = deals.filter((deal) => deal.stageId === stage.id);
      const ownership = getDealStageMetadata(
        stageDeals[0] ?? {
          stageId: stage.id,
          workflowRoute: "normal",
          isBidBoardOwned: false,
          bidBoardStageSlug: null,
          readOnlySyncedAt: null,
        },
        stages
      );

      return {
        stage,
        deals: stageDeals,
        ownership,
      };
    });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Deals</h2>
          <p className="text-sm text-muted-foreground">
            {pagination.total} deal{pagination.total !== 1 ? "s" : ""}
          </p>
        </div>
        <Button onClick={() => navigate("/deals/new")}>
          <Plus className="h-4 w-4 mr-2" />
          New Deal
        </Button>
      </div>

      {/* Filters */}
      <DealFilters
        filters={filters}
        onFilterChange={setFilters}
        onReset={resetFilters}
      />

      {/* Error State */}
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      )}

      {/* Deal List */}
      {!loading && deals.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Building2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No deals found</p>
          <p className="text-sm">Try adjusting your filters or create a new deal.</p>
        </div>
      )}

      {!loading && deals.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-4">
          {columns.map((column) => (
            <section key={column.stage.id} className="space-y-3 rounded-2xl border bg-muted/20 p-3">
              <div className="border-b pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">
                      {column.stage.name}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {column.ownership.isReadOnlyInCrm ? (
                        <>
                          <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-1 font-semibold text-slate-700">
                            Bid Board mirror
                          </span>
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 font-semibold text-amber-800">
                            Read-only in CRM
                          </span>
                        </>
                      ) : (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">
                          CRM editable
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="rounded-full border bg-background px-2 py-1 text-xs font-semibold text-muted-foreground">
                    {column.deals.length}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                {column.deals.map((deal) => {
                  const stageMeta = getDealStageMetadata(deal, stages);
                  const regionName = deal.regionId ? regionNameById.get(deal.regionId) ?? deal.regionId : null;

                  return (
                    <Card
                      key={deal.id}
                      className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => navigate(`/deals/${deal.id}`)}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <span className="text-xs text-muted-foreground font-mono">
                              {deal.dealNumber}
                            </span>
                            <DealStageBadge
                              stageId={deal.stageId}
                              readOnly={stageMeta.isReadOnlyInCrm}
                              ownership={stageMeta.sourceOfTruth}
                            />
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              deal.workflowRoute === "service"
                                ? "bg-blue-50 text-blue-700"
                                : "bg-zinc-100 text-zinc-700"
                            }`}>
                              {getWorkflowRouteLabel(deal.workflowRoute)}
                            </span>
                          </div>
                          <h3 className="font-semibold truncate">{deal.name}</h3>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            {regionName && <span>{regionName}</span>}
                            {deal.propertyCity && (
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                {deal.propertyCity}, {deal.propertyState}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {daysInStage(deal.stageEnteredAt)}d in stage
                            </span>
                            <span>Updated {timeAgo(deal.updatedAt)}</span>
                          </div>
                          {stageMeta.isReadOnlyInCrm && (
                            <div className="mt-3 flex items-center gap-1 text-xs font-medium text-slate-600">
                              <Lock className="h-3 w-3" />
                              Read-only in CRM
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-semibold">
                            {formatCurrency(bestEstimate(deal))}
                          </p>
                          {deal.winProbability != null && (
                            <p className="text-xs text-muted-foreground">
                              {deal.winProbability}% probability
                            </p>
                          )}
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
