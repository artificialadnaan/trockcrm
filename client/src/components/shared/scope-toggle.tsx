import { cn } from "@/lib/utils";

export type ScopeToggleOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
};

export function ScopeToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel = "Scope",
  className,
  size = "sm",
}: {
  options: readonly ScopeToggleOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
  /**
   * "sm" (default) preserves the original compact pill on every viewport.
   * "touch" enforces a >=44px tap target on phones and collapses back to the
   * compact pill at >=md, for use on mobile-first surfaces like the dashboards.
   */
  size?: "sm" | "touch";
}) {
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-full bg-slate-100 p-1", className)} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full font-bold transition-colors",
              // Default "sm" keeps the original compact pill (px-3.5 py-1.5 text-xs).
              // "touch" enforces >=44px on phones and reverts to the compact pill at >=md.
              size === "touch"
                ? "min-h-[44px] px-4 py-2.5 text-sm md:min-h-0 md:px-3.5 md:py-1.5 md:text-xs"
                : "px-3.5 py-1.5 text-xs",
              isActive ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900",
            )}
            aria-pressed={isActive}
          >
            {option.label}
            {option.count != null ? <span className="ml-1 tabular-nums">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
