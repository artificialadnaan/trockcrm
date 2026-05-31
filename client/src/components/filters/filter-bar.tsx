import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import { TerminalDateFilterControl } from "@/components/pipeline/terminal-date-filter-control";
import { cn } from "@/lib/utils";
import { MultiSelectMenu, type MultiSelectOption } from "./multi-select-menu";
import { NumericRangePopover, type NumericRangeBucket } from "./numeric-range-popover";
import { FilterSelect, type FilterSelectOption } from "./filter-select";
import { resolveDateWindow, dateFilterFromValue } from "./filterbar-date";
import { UNASSIGNED, type DealStatusFilter, type FilterBarValue } from "./filterbar-params";

export type FilterDimension =
  | "search"
  | "scope"
  | "date"
  | "stage"
  | "sort"
  | "rep"
  | "status"
  | "workflow"
  | "region"
  | "projectType"
  | "value"
  | "stalled";

export interface FilterBarSortOption {
  label: string;
  sortBy: string;
  sortDir: "asc" | "desc";
}

export interface FilterBarOptions {
  reps?: FilterSelectOption[];
  regions?: FilterSelectOption[];
  projectTypes?: FilterSelectOption[];
  stages?: MultiSelectOption[];
  sortOptions?: FilterBarSortOption[];
}

type ScopeValue = "mine" | "team" | "all";

const STATUS_OPTIONS: FilterSelectOption[] = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On hold" },
  { value: "inactive", label: "Inactive" },
];
const WORKFLOW_OPTIONS: FilterSelectOption[] = [
  { value: "normal", label: "Normal" },
  { value: "service", label: "Service" },
];
const STALLED_BUCKETS: NumericRangeBucket[] = [
  { label: "> 30 days", min: 30 },
  { label: "> 60 days", min: 60 },
  { label: "> 90 days", min: 90 },
];
const DEFAULT_SCOPE_OPTIONS: ScopeToggleOption<ScopeValue>[] = [
  { value: "mine", label: "Mine" },
  { value: "team", label: "Team" },
  { value: "all", label: "All" },
];
const formatDollars = (n: number) => `$${n.toLocaleString()}`;
const formatDays = (n: number) => `${n}d`;

interface FilterBarProps {
  /** Which dimensions this surface shows, in render order. */
  dimensions: FilterDimension[];
  value: FilterBarValue;
  onChange: (patch: Partial<FilterBarValue>) => void;
  onReset: () => void;
  options?: FilterBarOptions;
  scopeOptions?: ScopeToggleOption<ScopeValue>[];
  /**
   * When false (the honest pre-backfill default), the date filter is labeled as covering only
   * Won/Lost + activity; open stages are shown as current-state. Flip true once
   * FEATURE_STAGE_ENTRY_DATE makes the open-stage entered-date reliable (post-#535 forward).
   */
  stageEntryDateEnabled?: boolean;
  className?: string;
}

/**
 * The shared, controlled FilterBar. Renders the configured dimensions (composing the FilterBar
 * primitives + ScopeToggle + the WTD date control) and emits Partial<FilterBarValue> patches whose
 * keys/values match BLUE's getDeals param contract (#546). Graceful: a dimension whose option list
 * is empty simply shows fewer choices; clearing a dimension omits its param.
 */
export function FilterBar({
  dimensions,
  value,
  onChange,
  onReset,
  options = {},
  scopeOptions = DEFAULT_SCOPE_OPTIONS,
  stageEntryDateEnabled = false,
  className,
}: FilterBarProps) {
  const has = (dimension: FilterDimension) => dimensions.includes(dimension);
  const sortOptions = options.sortOptions ?? [];
  const currentSortIndex = sortOptions.findIndex(
    (option) => option.sortBy === value.sortBy && option.sortDir === value.sortDir
  );

  return (
    <div role="group" aria-label="Filters" className={cn("flex flex-wrap items-center gap-2", className)}>
      {has("search") && (
        <Input
          aria-label="Search"
          placeholder="Search…"
          value={value.search ?? ""}
          onChange={(event) => onChange({ search: event.target.value || undefined })}
          className="h-8 w-48"
        />
      )}

      {has("scope") && (
        <ScopeToggle
          options={scopeOptions}
          value={(value.scope as ScopeValue) ?? "all"}
          onChange={(scope) => onChange({ scope })}
          ariaLabel="Scope"
        />
      )}

      {has("date") && (
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">Date:</span>
          <TerminalDateFilterControl
            stageName="Date"
            filter={dateFilterFromValue(value)}
            onFilterChange={(filter) => onChange(resolveDateWindow(filter))}
          />
          {!stageEntryDateEnabled && (
            <span className="text-[11px] leading-tight text-muted-foreground" data-testid="date-scope-note">
              Won/Lost &amp; activity · open stages show current state
            </span>
          )}
        </div>
      )}

      {has("stage") && (
        <MultiSelectMenu
          label="Stage"
          options={options.stages ?? []}
          value={value.stageIds ?? []}
          onChange={(stageIds) => onChange({ stageIds })}
        />
      )}

      {has("rep") && (
        <FilterSelect
          label="Rep"
          allLabel="All reps"
          value={value.assignedRepId}
          options={[{ value: UNASSIGNED, label: "Unassigned" }, ...(options.reps ?? [])]}
          onChange={(assignedRepId) => onChange({ assignedRepId })}
        />
      )}

      {has("region") && (
        <FilterSelect
          label="Region"
          allLabel="All regions"
          value={value.regionId}
          options={[{ value: UNASSIGNED, label: "Unassigned" }, ...(options.regions ?? [])]}
          onChange={(regionId) => onChange({ regionId })}
        />
      )}

      {has("projectType") && (
        <FilterSelect
          label="Type"
          allLabel="All types"
          value={value.projectTypeId}
          options={options.projectTypes ?? []}
          onChange={(projectTypeId) => onChange({ projectTypeId })}
        />
      )}

      {has("workflow") && (
        <FilterSelect
          label="Workflow"
          allLabel="All"
          value={value.workflowRoute}
          options={WORKFLOW_OPTIONS}
          onChange={(workflowRoute) => onChange({ workflowRoute: workflowRoute as "normal" | "service" | undefined })}
        />
      )}

      {has("status") && (
        <FilterSelect
          label="Status"
          allLabel="Any"
          value={value.status === "any" ? undefined : value.status}
          options={STATUS_OPTIONS}
          onChange={(status) => onChange({ status: (status as DealStatusFilter | undefined) ?? "any" })}
        />
      )}

      {has("value") && (
        <NumericRangePopover
          label="Value"
          emptyLabel="Any"
          format={formatDollars}
          value={{ min: value.valueMin, max: value.valueMax }}
          onChange={(range) => onChange({ valueMin: range.min, valueMax: range.max })}
        />
      )}

      {has("stalled") && (
        <NumericRangePopover
          label="Stalled"
          emptyLabel="Any"
          format={formatDays}
          buckets={STALLED_BUCKETS}
          value={{ min: value.minAgeDays, max: value.maxAgeDays }}
          onChange={(range) => onChange({ minAgeDays: range.min, maxAgeDays: range.max })}
        />
      )}

      {has("sort") && sortOptions.length > 0 && (
        <FilterSelect
          label="Sort"
          allLabel="Default"
          value={currentSortIndex >= 0 ? String(currentSortIndex) : undefined}
          options={sortOptions.map((option, index) => ({ value: String(index), label: option.label }))}
          onChange={(picked) => {
            const option = picked != null ? sortOptions[Number(picked)] : undefined;
            onChange({ sortBy: option?.sortBy, sortDir: option?.sortDir });
          }}
        />
      )}

      <Button variant="ghost" size="sm" onClick={onReset} className="h-8" aria-label="Clear filters">
        <X className="mr-1 h-4 w-4" />
        Clear
      </Button>
    </div>
  );
}
