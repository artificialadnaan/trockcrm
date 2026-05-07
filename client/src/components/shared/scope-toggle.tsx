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
}: {
  options: readonly ScopeToggleOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
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
              "rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors",
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
