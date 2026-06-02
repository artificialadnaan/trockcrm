import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { FilterSelectOption } from "./filter-select";

interface PresetSelectProps {
  /** Accessible name for the trigger. The date slot renders its own "Date:" label, so pass a
   *  descriptive name here (e.g. "Date range"). */
  ariaLabel: string;
  /** The current option value — ALWAYS set (no "All"/no-filter state, unlike FilterSelect). */
  value: string;
  options: FilterSelectOption[];
  onChange: (value: string) => void;
  /** Optional inline label prefix shown in the trigger (e.g. "Date"). Omit when the slot renders its own. */
  label?: string;
  className?: string;
}

/**
 * A single-select FilterBar dropdown for a NON-nullable choice — every option is a concrete value
 * and there is NO "All"/clear sentinel (unlike FilterSelect, which injects one that maps to undefined).
 * Built for surface-owned presets such as the rep drill-down's Date control, whose options are the
 * page's listRange windows (Dashboard / 7D / WTD / MTD / QTD / YTD) bound to a single source of truth.
 * ALWAYS passes `items` to <Select> so the trigger shows the human label, never the raw value
 * (the repo's recurring Base UI bug — memory: base-ui-select-items-label).
 */
export function PresetSelect({ ariaLabel, value, options, onChange, label, className }: PresetSelectProps) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next: string | null) => {
        // The select is non-nullable; ignore a null (no real option maps to it).
        if (next) onChange(next);
      }}
    >
      <SelectTrigger aria-label={ariaLabel} className={cn("h-8 gap-1 text-sm", className)}>
        {label ? <span className="text-muted-foreground">{label}:</span> : null}
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
