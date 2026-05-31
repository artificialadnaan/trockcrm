import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface FilterSelectOption {
  value: string;
  label: string;
}

/** Sentinel for the "no filter" choice (distinct from the data-level "__unassigned__"). */
export const ALL_OPTION = "__all__";

/** Map a Base UI Select change to the emitted value: the "all" sentinel / null / "" -> undefined
 *  (so the caller omits the param), any real value -> itself. */
export function resolveFilterSelectChange(next: string | null): string | undefined {
  return !next || next === ALL_OPTION ? undefined : next;
}

interface FilterSelectProps {
  label: string;
  /** Current value (a real option value), or undefined = the "all" choice. */
  value: string | undefined;
  options: FilterSelectOption[];
  /** Emits the chosen value, or undefined when "all" is picked (caller omits the param). */
  onChange: (value: string | undefined) => void;
  allLabel?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * A single-select FilterBar dropdown. ALWAYS passes `items` to <Select> AND <SelectValue> children
 * so the trigger shows the human label, never a raw UUID/code (the repo's recurring Base UI bug —
 * memory: base-ui-select-items-label). Picking "All" emits undefined so the param is omitted.
 */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  allLabel = "All",
  ariaLabel,
  className,
}: FilterSelectProps) {
  const items: FilterSelectOption[] = [{ value: ALL_OPTION, label: allLabel }, ...options];
  const current = value ?? ALL_OPTION;
  const selectedLabel = items.find((item) => item.value === current)?.label ?? allLabel;

  return (
    <Select
      items={items}
      value={current}
      onValueChange={(next: string | null) => onChange(resolveFilterSelectChange(next))}
    >
      <SelectTrigger aria-label={ariaLabel ?? `${label} filter`} className={cn("h-8 gap-1 text-sm", className)}>
        <span className="text-muted-foreground">{label}:</span>
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
