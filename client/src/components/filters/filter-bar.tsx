import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
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
  /** Opt-in Status option set for non-deal surfaces (e.g. leads: open/converted/disqualified).
   *  Defaults to the deal statuses, so existing deals mounts are unchanged. */
  statusOptions?: FilterSelectOption[];
  /** Whether the Rep/Region controls offer an "Unassigned" (IS NULL) option. Default true (deals,
   *  where assigned_rep_id/region_id are nullable). Set false on surfaces with non-null FKs (e.g.
   *  leads: assignedRepId is a non-null UUID, so the sentinel would error/no-match) — Codex #577 P1. */
  allowUnassigned?: boolean;
  /** Label for the Rep dimension. Defaults to "Rep" (deals/pipeline/leads). Surfaces that filter by a
   *  generic owner_id rather than a sales rep set this (e.g. Companies: "Owner", #582). Drives both the
   *  control label and its "All …" option, so existing mounts are byte-identical. */
  repLabel?: string;
}

type ScopeValue = "mine" | "team" | "all";

/** Default Status options (deals). A surface can override via FilterBarOptions.statusOptions. */
const DEAL_STATUS_OPTIONS: FilterSelectOption[] = [
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

/** Status select -> patch. "All" (undefined) maps to "any" (the omitted state); a real choice
 *  passes through verbatim. Never emits isActive — Status owns is_active/on_hold (contract #546). */
export function statusPatch(selected: string | undefined): Pick<FilterBarValue, "status"> {
  return { status: (selected as DealStatusFilter | undefined) ?? "any" };
}

/** Sort select (stores the option index) -> {sortBy, sortDir}. "Default" (undefined) clears both. */
export function sortPatch(
  picked: string | undefined,
  options: FilterBarSortOption[]
): Pick<FilterBarValue, "sortBy" | "sortDir"> {
  const option = picked != null ? options[Number(picked)] : undefined;
  return { sortBy: option?.sortBy, sortDir: option?.sortDir };
}

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
  // Whether Rep/Region offer the "Unassigned" (IS NULL) option (default yes; off for non-null FKs like leads).
  const unassignedOption = (options.allowUnassigned ?? true) ? [{ value: UNASSIGNED, label: "Unassigned" }] : [];

  // When stage-entry dates are off, the stalled control is hidden — also CLEAR any stale
  // minAgeDays/maxAgeDays from a bookmarked URL so the list isn't filtered by an invisible
  // constraint with no way to see or remove it (Codex #548). Self-heals to a no-op once cleared.
  useEffect(() => {
    if (!stageEntryDateEnabled && (value.minAgeDays !== undefined || value.maxAgeDays !== undefined)) {
      onChange({ minAgeDays: undefined, maxAgeDays: undefined });
    }
  }, [stageEntryDateEnabled, value.minAgeDays, value.maxAgeDays, onChange]);
  const currentSortIndex = sortOptions.findIndex(
    (option) => option.sortBy === value.sortBy && option.sortDir === value.sortDir
  );

  return (
    <div role="group" aria-label="Filters" className={cn("flex flex-wrap items-center gap-2", className)}>
      {has("search") && (
        <SearchInput
          aria-label="Search"
          placeholder="Search…"
          value={value.search ?? ""}
          onChange={(next) => onChange({ search: next || undefined })}
          className="w-48"
        />
      )}

      {has("scope") && (
        <ScopeToggle
          options={scopeOptions}
          // Default the highlighted scope to the server's getDeals default ("mine") so the active
          // pill matches the data actually returned when no scope param is set.
          value={(value.scope as ScopeValue) ?? "mine"}
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
          label={options.repLabel ?? "Rep"}
          allLabel={`All ${(options.repLabel ?? "Rep").toLowerCase()}s`}
          value={value.assignedRepId}
          options={[...unassignedOption, ...(options.reps ?? [])]}
          onChange={(assignedRepId) => onChange({ assignedRepId })}
        />
      )}

      {has("region") && (
        <FilterSelect
          label="Region"
          allLabel="All regions"
          value={value.regionId}
          options={[...unassignedOption, ...(options.regions ?? [])]}
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
          options={options.statusOptions ?? DEAL_STATUS_OPTIONS}
          onChange={(status) => onChange(statusPatch(status))}
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

      {has("stalled") && stageEntryDateEnabled && (
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
          onChange={(picked) => onChange(sortPatch(picked, sortOptions))}
        />
      )}

      <Button variant="ghost" size="sm" onClick={onReset} className="h-8" aria-label="Clear filters">
        <X className="mr-1 h-4 w-4" />
        Clear
      </Button>
    </div>
  );
}
