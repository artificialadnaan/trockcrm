import type { MouseEvent } from "react";
import { daysAgo, type TerminalDateFilter } from "@/lib/pipeline-terminal-filters";
import { cn } from "@/lib/utils";

const PRESETS = [
  { value: "30", label: "30d", aria: "from the last 30 days" },
  { value: "60", label: "60d", aria: "from the last 60 days" },
  { value: "90", label: "90d", aria: "from the last 90 days" },
  { value: "custom", label: "Custom", aria: "from a custom date range" },
] as const;

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
      {PRESETS.map((preset) => (
        <button
          key={preset.value}
          type="button"
          aria-label={`Show ${stageName} deals ${preset.aria}`}
          aria-pressed={filter.preset === preset.value}
          className={cn(
            "h-7 rounded-full border px-2 text-[11px] font-bold transition-colors",
            filter.preset === preset.value
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900",
            buttonClassName
          )}
          onClick={(event) => handleClick(event, preset.value)}
        >
          {preset.label}
        </button>
      ))}
      {filter.preset === "custom" ? (
        <>
          <input
            aria-label={`${stageName} start date`}
            type="date"
            className={cn(
              "h-7 min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600",
              inputClassName
            )}
            value={filter.customStart}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onFilterChange({ ...filter, customStart: event.target.value })}
          />
          <input
            aria-label={`${stageName} end date`}
            type="date"
            className={cn(
              "h-7 min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600",
              inputClassName
            )}
            value={filter.customEnd ?? ""}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) =>
              onFilterChange({
                ...filter,
                customEnd: event.target.value || undefined,
              })
            }
          />
        </>
      ) : null}
    </div>
  );
}
