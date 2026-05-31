import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type MultiSelectOption = { value: string; label: string };

/** Add `value` if absent, remove it if present. Pure. */
export function toggleSelection(current: string[], value: string): string[] {
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

/** Trigger summary: empty label / single option label / "N selected". Pure. */
export function summarizeSelection(value: string[], options: MultiSelectOption[], emptyLabel: string): string {
  if (value.length === 0) return emptyLabel;
  if (value.length === 1) return options.find((o) => o.value === value[0])?.label ?? value[0];
  return `${value.length} selected`;
}

interface MultiSelectMenuProps {
  label: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Trigger text + first menu row when nothing is selected. */
  emptyLabel?: string;
  ariaLabel?: string;
  className?: string;
  buttonClassName?: string;
}

/**
 * Generic multi-select dropdown (checkbox menu) for the shared FilterBar.
 * Controlled: parent owns `value` (the selected option values); emits the next array on toggle.
 * Graceful: renders only the options it is given, so a sparsely-populated dimension simply shows
 * fewer rows; an empty selection means "no filter" (the caller omits the param).
 */
export function MultiSelectMenu({
  label,
  options,
  value,
  onChange,
  emptyLabel = "All",
  ariaLabel,
  className,
  buttonClassName,
}: MultiSelectMenuProps) {
  const summary = summarizeSelection(value, options, emptyLabel);

  return (
    <div className={cn("inline-flex", className)}>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={ariaLabel ?? `${label} filter`}
              className={cn("h-8 gap-1 text-sm font-medium", buttonClassName)}
            >
              <span className="text-muted-foreground">{label}:</span>
              <span className="font-semibold">{summary}</span>
              <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
            </Button>
          }
        />
        <PopoverContent align="start" className="w-56 space-y-0.5 p-1">
          {value.length > 0 && (
            <button
              type="button"
              className="mb-1 w-full rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted"
              onClick={() => onChange([])}
            >
              Clear selection
            </button>
          )}
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No options</p>
          ) : (
            options.map((option) => {
              const checked = value.includes(option.value);
              return (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    value={option.value}
                    checked={checked}
                    onChange={() => onChange(toggleSelection(value, option.value))}
                    className="h-4 w-4 rounded border-gray-300 text-brand-red focus:ring-brand-red"
                  />
                  <span>{option.label}</span>
                </label>
              );
            })
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
