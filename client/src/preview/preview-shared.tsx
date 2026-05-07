import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";

export const USD = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);

export const USD_COMPACT = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(
    value
  );

export const NUMBER_COMPACT = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function MetricCard({
  eyebrow,
  value,
  badge,
  badgeTone = "green",
  caption,
  drenched = false,
  accent = "red",
}: {
  eyebrow: string;
  value: string;
  badge: string;
  badgeTone?: "green" | "blue" | "white";
  caption: string;
  drenched?: boolean;
  accent?: "red" | "blue" | "green";
}) {
  const accentColor = accent === "blue" ? "bg-blue-400" : accent === "green" ? "bg-emerald-400" : "bg-brand-red";
  if (drenched) {
    return (
      <Card className="relative overflow-hidden border-0 bg-brand-red text-white shadow-md">
        <CardContent className="p-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">{eyebrow}</p>
          <p className="mt-2 text-4xl font-black leading-none tracking-tight">{value}</p>
          <div className="mt-3 flex items-center gap-3">
            <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ring-white/20">
              {badge}
            </span>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">{caption}</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  const badgeStyles = {
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    white: "bg-white text-slate-700 ring-1 ring-slate-200",
  } as const;
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-5">
        <p className={EYEBROW}>{eyebrow}</p>
        <p className="mt-2 text-4xl font-black leading-none tracking-tight text-slate-950">{value}</p>
        <div className="mt-3 flex items-center gap-3">
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badgeStyles[badgeTone]}`}>
            {badge}
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{caption}</p>
        </div>
      </CardContent>
      <div className={`absolute inset-x-0 bottom-0 h-1 ${accentColor}`} aria-hidden />
    </Card>
  );
}

export function ActivityTimeline({
  items,
  renderIcon,
}: {
  items: Array<{ id: string; icon: string; who: string; what: string; when: string }>;
  renderIcon: (kind: string) => ReactNode;
}) {
  return (
    <ol className="space-y-4">
      {items.map((a, i, arr) => (
        <li key={a.id} className="relative flex items-start gap-3">
          {i < arr.length - 1 ? (
            <span
              className="absolute left-4 top-9 -ml-px w-px bg-slate-200"
              style={{ bottom: "-1rem" }}
              aria-hidden
            />
          ) : null}
          {renderIcon(a.icon)}
          <div className="min-w-0 flex-1 pt-1">
            <p className="text-sm font-semibold text-slate-950">{a.what}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              <span className="font-semibold">{a.who}</span> · {a.when}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

type DetailTab<K extends string> = {
  key: K;
  label: string;
  icon: ReactNode;
  count?: number;
};

export function DetailTabs<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<DetailTab<K>>;
  active: K;
  onChange: (next: K) => void;
}) {
  const activeTab = tabs.find((t) => t.key === active);
  return (
    <div className="border-b border-slate-100">
      <div className="flex items-center gap-1 px-3 pt-2">
        {tabs.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              title={t.label}
              aria-label={t.label}
              aria-current={isActive ? "page" : undefined}
              className={`relative flex items-center gap-1 rounded-t-md border-b-2 px-3 py-3 transition-colors ${
                isActive
                  ? "border-brand-red text-brand-red"
                  : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <span className="flex h-4 w-4 items-center justify-center">{t.icon}</span>
              {t.count != null ? (
                <span
                  className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums ${
                    isActive ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {t.count}
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

export function ScopeToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1">
      {options.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
            value === s ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
