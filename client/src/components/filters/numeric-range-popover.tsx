import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type NumericRangeValue = { min?: number; max?: number };
export type NumericRangeBucket = { label: string; min?: number; max?: number };

interface SummarizeOptions {
  emptyLabel?: string;
  format?: (n: number) => string;
  buckets?: NumericRangeBucket[];
}

/** "Any" / a matching bucket label / "min–max" / "≥ min" / "≤ max". Pure. */
export function summarizeRange(value: NumericRangeValue, options: SummarizeOptions): string {
  const { emptyLabel = "Any", format = (n: number) => String(n), buckets } = options;
  const { min, max } = value;
  if (min === undefined && max === undefined) return emptyLabel;
  const bucket = buckets?.find((b) => b.min === min && b.max === max);
  if (bucket) return bucket.label;
  if (min !== undefined && max !== undefined) return `${format(min)}–${format(max)}`;
  if (min !== undefined) return `≥ ${format(min)}`;
  return `≤ ${format(max as number)}`;
}

function parseNumericInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface NumericRangePopoverProps {
  label: string;
  value: NumericRangeValue;
  onChange: (next: NumericRangeValue) => void;
  emptyLabel?: string;
  /** Formats a bound for the trigger summary (e.g. dollars). */
  format?: (n: number) => string;
  /** Optional quick-select buckets (e.g. > 30 / > 60 / > 90 days). */
  buckets?: NumericRangeBucket[];
  ariaLabel?: string;
  className?: string;
  buttonClassName?: string;
}

/**
 * Generic numeric min/max range dropdown for the shared FilterBar (value range, days-in-stage).
 * Controlled: parent owns `value`; emits `{ min, max }` (either may be undefined). Buckets emit
 * immediately; typed bounds commit on Apply. Empty range ({}) means "no filter".
 */
export function NumericRangePopover({
  label,
  value,
  onChange,
  emptyLabel = "Any",
  format,
  buckets,
  ariaLabel,
  className,
  buttonClassName,
}: NumericRangePopoverProps) {
  const summary = summarizeRange(value, { emptyLabel, format, buckets });
  const [draftMin, setDraftMin] = useState(value.min?.toString() ?? "");
  const [draftMax, setDraftMax] = useState(value.max?.toString() ?? "");

  useEffect(() => {
    setDraftMin(value.min?.toString() ?? "");
    setDraftMax(value.max?.toString() ?? "");
  }, [value.min, value.max]);

  const apply = () => onChange({ min: parseNumericInput(draftMin), max: parseNumericInput(draftMax) });
  const hasValue = value.min !== undefined || value.max !== undefined;

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
        <PopoverContent align="start" className="w-60 space-y-2 p-2">
          {buckets && buckets.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {buckets.map((bucket) => (
                <button
                  key={bucket.label}
                  type="button"
                  className="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-brand-red/40 hover:text-brand-red"
                  onClick={() => onChange({ min: bucket.min, max: bucket.max })}
                >
                  {bucket.label}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              aria-label={`${label} minimum`}
              placeholder="Min"
              value={draftMin}
              onChange={(event) => setDraftMin(event.target.value)}
              className="h-8 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700"
            />
            <input
              type="number"
              aria-label={`${label} maximum`}
              placeholder="Max"
              value={draftMax}
              onChange={(event) => setDraftMax(event.target.value)}
              className="h-8 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            {hasValue ? (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                onClick={() => onChange({})}
              >
                Clear
              </button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-md bg-brand-red text-xs font-black text-white hover:bg-brand-red/90"
              onClick={apply}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
