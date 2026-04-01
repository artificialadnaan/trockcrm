import { useNavigate } from "react-router-dom";
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Building2,
  MapPin,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { DealFilters } from "@/components/deals/deal-filters";
import { useDeals } from "@/hooks/use-deals";
import { useDealFilters } from "@/hooks/use-deal-filters";
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
        <div className="space-y-2">
          {deals.map((deal) => (
            <Card
              key={deal.id}
              className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => navigate(`/deals/${deal.id}`)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-muted-foreground font-mono">
                      {deal.dealNumber}
                    </span>
                    <DealStageBadge stageId={deal.stageId} />
                  </div>
                  <h3 className="font-semibold truncate">{deal.name}</h3>
                  <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
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
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setFilters({ page: pagination.page - 1 })}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setFilters({ page: pagination.page + 1 })}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
