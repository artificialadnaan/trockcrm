import { useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import type { DealFilters as DealFilterValues } from "@/hooks/use-deals";

interface DealFiltersProps {
  filters: DealFilterValues;
  onFilterChange: (update: Partial<DealFilterValues>) => void;
  onReset: () => void;
}

export function DealFilters({ filters, onFilterChange, onReset }: DealFiltersProps) {
  const { stages } = usePipelineStages();
  const { projectTypes } = useProjectTypes();
  const { regions } = useRegions();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activeStages = stages.filter((s) => !s.isTerminal);
  const terminalStages = stages.filter((s) => s.isTerminal);

  const activeFilterCount = [
    filters.stageIds?.length ? 1 : 0,
    filters.projectTypeId ? 1 : 0,
    filters.regionId ? 1 : 0,
    filters.source ? 1 : 0,
    filters.assignedRepId ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-3">
      {/* Search + Filter Toggle */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search deals..."
            className="pl-9"
            value={filters.search ?? ""}
            onChange={(e) => onFilterChange({ search: e.target.value || undefined })}
          />
        </div>
        <Button
          variant={showAdvanced ? "secondary" : "outline"}
          size="icon"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="relative"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-brand-red text-[10px] text-white flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </Button>
        {activeFilterCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Advanced Filters */}
      {showAdvanced && (
        <div className="flex flex-wrap gap-3 p-3 bg-muted/50 rounded-lg">
          {/* Stage filter */}
          <Select
            value={filters.stageIds?.[0] ?? "all"}
            onValueChange={(val: string | null) =>
              onFilterChange({ stageIds: !val || val === "all" ? undefined : [val] })
            }
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stages</SelectItem>
              {activeStages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              {terminalStages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Project Type filter */}
          <Select
            value={filters.projectTypeId ?? "all"}
            onValueChange={(val: string | null) =>
              onFilterChange({ projectTypeId: !val || val === "all" ? undefined : val })
            }
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Project Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {projectTypes.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Region filter */}
          <Select
            value={filters.regionId ?? "all"}
            onValueChange={(val: string | null) =>
              onFilterChange({ regionId: !val || val === "all" ? undefined : val })
            }
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Regions</SelectItem>
              {regions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Sort */}
          <Select
            value={filters.sortBy ?? "updated_at"}
            onValueChange={(val: string | null) => onFilterChange({ sortBy: val ?? "updated_at" })}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated_at">Last Updated</SelectItem>
              <SelectItem value="created_at">Date Created</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="awarded_amount">Awarded Amount</SelectItem>
              <SelectItem value="stage_entered_at">Days in Stage</SelectItem>
              <SelectItem value="expected_close_date">Expected Close</SelectItem>
            </SelectContent>
          </Select>

          {/* Active/Inactive toggle */}
          <Button
            variant={filters.isActive === false ? "secondary" : "outline"}
            size="sm"
            onClick={() =>
              onFilterChange({ isActive: filters.isActive === false ? true : false })
            }
          >
            {filters.isActive === false ? "Showing Inactive" : "Active Only"}
          </Button>
        </div>
      )}
    </div>
  );
}
