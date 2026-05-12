import type { MouseEvent } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { clampDateToToday, daysAgo, getTodayDateParam, type TerminalDateFilter } from "@/lib/pipeline-terminal-filters";
import { cn } from "@/lib/utils";

const PRESETS = [
  { value: "7", label: "Last 7 days", chip: "Last 7d", aria: "from the last 7 days" },
  { value: "30", label: "Last 30 days", chip: "Last 30d", aria: "from the last 30 days" },
  { value: "60", label: "Last 60 days", chip: "Last 60d", aria: "from the last 60 days" },
  { value: "90", label: "Last 90 days", chip: "Last 90d", aria: "from the last 90 days" },
  { value: "all", label: "All time", chip: "All time", aria: "from all time" },
  { value: "custom", label: "Custom range", aria: "from a custom date range" },
] as const;

function chipLabel(filter: TerminalDateFilter) {
  if (filter.preset === "custom") return "Custom";
  const preset = PRESETS.find((item) => item.value === filter.preset);
  return preset && "chip" in preset ? preset.chip : "Last 30d";
}

export function TerminalDateFilterControl({
  stageName,
  filter,
  onFilterChange,
  className,
  buttonClassName,
  inputClassName,
}: {
  stageName: string;
  filter: TerminalDateFilter;
  onFilterChange: (filter: TerminalDateFilter) => void;
  className?: string;
  buttonClassName?: string;
  inputClassName?: string;
}) {
  const maxDate = getTodayDateParam();

  const handleClick = (
    event: MouseEvent<HTMLButtonElement>,
    value: TerminalDateFilter["preset"]
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onFilterChange(value === "custom" ? { preset: "custom", customStart: daysAgo(30) } : { preset: value });
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} onClick={(event) => event.stopPropagation()}>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`${stageName} date filter`}
              className={cn(
                "h-7 rounded-full border-slate-300 bg-white px-2.5 text-[11px] font-black text-slate-700 hover:border-brand-red/40 hover:text-brand-red",
                buttonClassName
              )}
            >
              {chipLabel(filter)}
              <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          }
        />
        <PopoverContent align="start" className="w-64 space-y-2 p-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              aria-label={`Show ${stageName} deals ${preset.aria}`}
              aria-pressed={filter.preset === preset.value}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm font-semibold transition-colors hover:bg-slate-100",
                filter.preset === preset.value ? "bg-brand-red/10 text-brand-red" : "text-slate-700"
              )}
              onClick={(event) => handleClick(event, preset.value)}
            >
              <span>{preset.label}</span>
              {filter.preset === preset.value ? <span className="h-2 w-2 rounded-full bg-brand-red" /> : null}
            </button>
          ))}
          {filter.preset === "custom" ? (
            <div className="grid gap-2 border-t border-slate-200 pt-2">
              <input
                aria-label={`${stageName} start date`}
                type="date"
                className={cn(
                  "h-8 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700",
                  inputClassName
                )}
                value={filter.customStart}
                max={maxDate}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onFilterChange({ ...filter, customStart: clampDateToToday(event.target.value) })}
              />
              <input
                aria-label={`${stageName} end date`}
                type="date"
                className={cn(
                  "h-8 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700",
                  inputClassName
                )}
                value={filter.customEnd ?? ""}
                max={maxDate}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) =>
                  onFilterChange({
                    ...filter,
                    customEnd: event.target.value ? clampDateToToday(event.target.value) : undefined,
                  })
                }
              />
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
