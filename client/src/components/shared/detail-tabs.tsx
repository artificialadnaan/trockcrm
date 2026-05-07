import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type DetailTab<K extends string> = {
  key: K;
  label: string;
  icon: ReactNode;
  count?: number;
};

export function DetailTabs<K extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<DetailTab<K>>;
  active: K;
  onChange: (next: K) => void;
  className?: string;
}) {
  const activeTab = tabs.find((tab) => tab.key === active);

  return (
    <div className={cn("border-b border-slate-100", className)}>
      <div className="flex items-center gap-1 overflow-x-auto px-3 pt-2">
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              title={tab.label}
              aria-label={tab.label}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex shrink-0 items-center gap-1 rounded-t-md border-b-2 px-3 py-3 transition-colors",
                isActive
                  ? "border-brand-red text-brand-red"
                  : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-900",
              )}
            >
              <span className="flex h-4 w-4 items-center justify-center">{tab.icon}</span>
              {tab.count != null ? (
                <span
                  className={cn(
                    "inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums",
                    isActive ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600",
                  )}
                >
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {activeTab ? (
        <div className="flex items-center gap-2 bg-slate-50/50 px-5 py-3">
          <span className="flex h-3.5 w-3.5 items-center justify-center text-brand-red">{activeTab.icon}</span>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-brand-red">{activeTab.label}</p>
        </div>
      ) : null}
    </div>
  );
}
