import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";

export type DetailPageShellKpi = {
  eyebrow: string;
  value: string;
  captionLabel?: string;
  captionContext?: string;
  accent?: "default" | "red";
};

export type DetailPageShellTab = {
  id: string;
  icon: ReactNode;
  label?: string;
  count?: number | string;
};

export type DetailPageShellProps = {
  parentLabel: string;
  parentHref: string;
  currentLabel: string;
  iconSlot: ReactNode;
  typeBadge: ReactNode;
  statusBadge?: ReactNode;
  title: string;
  subtitleSlot?: ReactNode;
  actionsSlot: ReactNode;
  kpis: DetailPageShellKpi[];
  subheaderSlot?: ReactNode;
  tabs: DetailPageShellTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  children: ReactNode;
  rightRail: ReactNode;
};

const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";

function formatTabLabel(tab: DetailPageShellTab) {
  return tab.label ?? tab.id.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function DetailPageShell({
  parentLabel,
  parentHref,
  currentLabel,
  iconSlot,
  typeBadge,
  statusBadge,
  title,
  subtitleSlot,
  actionsSlot,
  kpis,
  subheaderSlot,
  tabs,
  activeTabId,
  onTabChange,
  children,
  rightRail,
}: DetailPageShellProps) {
  const activeTabLabel = formatTabLabel(tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? { id: activeTabId, icon: null });

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
        <Link to={parentHref} className="inline-flex items-center gap-1 text-slate-500 transition hover:text-brand-red">
          <ArrowLeft className="h-3.5 w-3.5" />
          {parentLabel}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
        <span className="max-w-full truncate text-slate-900">{currentLabel}</span>
      </nav>

      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center">
          <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl bg-slate-950 text-white shadow-sm">
            {iconSlot}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {typeBadge}
              {statusBadge}
            </div>
            <h1 className="mt-1 break-words text-3xl font-black uppercase tracking-tight text-slate-950 md:text-4xl">
              {title}
            </h1>
            {subtitleSlot ? <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">{subtitleSlot}</div> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actionsSlot}</div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {kpis.map((kpi) => {
          const isRed = kpi.accent === "red";
          return (
            <Card key={kpi.eyebrow} className={isRed ? "border-0 bg-brand-red text-white shadow-md" : "relative overflow-hidden"}>
              <CardContent className="p-5">
                <p className={isRed ? "text-[11px] font-bold uppercase tracking-[0.2em] text-red-100" : EYEBROW}>{kpi.eyebrow}</p>
                <div className="mt-3 text-4xl font-black tracking-tight">{kpi.value}</div>
                {(kpi.captionLabel || kpi.captionContext) && (
                  <div className={isRed ? "mt-3 text-xs text-red-50" : "mt-3 text-xs text-slate-500"}>
                    {kpi.captionLabel ? (
                      <span
                        className={
                          isRed
                            ? "mr-2 rounded-full bg-white/20 px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-white"
                            : "mr-2 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-700"
                        }
                      >
                        {kpi.captionLabel}
                      </span>
                    ) : null}
                    {kpi.captionContext}
                  </div>
                )}
              </CardContent>
              {!isRed ? <div className="absolute inset-x-0 bottom-0 h-1 bg-brand-red" /> : null}
            </Card>
          );
        })}
      </section>

      {subheaderSlot ? <section>{subheaderSlot}</section> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <div className="border-b border-slate-100">
              <div className="overflow-x-auto px-3 pt-3">
                <div className="flex min-w-max items-center gap-1">
                {tabs.map((tab) => {
                  const label = formatTabLabel(tab);
                  const isActive = tab.id === activeTabId;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      aria-label={label}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => onTabChange(tab.id)}
                      className={
                        isActive
                          ? "relative inline-flex h-11 items-center gap-2 border-b-2 border-brand-red px-3 text-sm font-black uppercase tracking-[0.12em] text-brand-red"
                          : "inline-flex h-11 items-center gap-2 border-b-2 border-transparent px-3 text-sm font-black uppercase tracking-[0.12em] text-slate-500 transition hover:border-slate-200 hover:text-slate-900"
                      }
                    >
                      <span className="flex h-5 w-5 items-center justify-center">{tab.icon}</span>
                      <span className="hidden sm:inline">{label}</span>
                      {tab.count !== undefined ? (
                        <span className={isActive ? "rounded-full bg-red-50 px-2 py-0.5 text-xs text-brand-red" : "rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500"}>
                          {tab.count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                </div>
              </div>
              <div className="bg-slate-50/50 px-5 py-3 text-xs font-black uppercase tracking-[0.18em] text-slate-500">
                {activeTabLabel}
              </div>
            </div>
            <CardContent className="p-5">{children}</CardContent>
          </Card>
        </div>

        <aside className="space-y-4">{rightRail}</aside>
      </div>
    </div>
  );
}

export function DetailRailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
      <p className={EYEBROW}>{title}</p>
      <div className="mt-2 space-y-2 text-sm text-slate-700">{children}</div>
    </section>
  );
}

export function DetailRailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p>
      <div className="mt-1 font-semibold text-slate-900">{value}</div>
    </div>
  );
}

export function DetailPageShellExample() {
  return (
    <DetailPageShell
      parentLabel="Properties"
      parentHref="/properties"
      currentLabel="Building A"
      iconSlot={<span className="text-2xl font-black">BA</span>}
      typeBadge={<span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-slate-700">School</span>}
      statusBadge={<span className="rounded-full bg-red-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-brand-red">Active</span>}
      title="Building A"
      subtitleSlot={<span>1200 Campus Dr · Dallas, TX</span>}
      actionsSlot={<button className="rounded-md border px-3 py-2 text-sm font-bold">Edit</button>}
      kpis={[
        { eyebrow: "Pipeline", value: "$1.2M", captionLabel: "3 deals", captionContext: "active" },
        { eyebrow: "Contacts", value: "8", captionContext: "linked" },
        { eyebrow: "Risk", value: "2", accent: "red", captionContext: "open blockers" },
      ]}
      tabs={[{ id: "activity", label: "Activity", icon: <span>A</span>, count: 4 }]}
      activeTabId="activity"
      onTabChange={() => undefined}
      rightRail={
        <Card>
          <CardContent className="space-y-4 p-5">
            <DetailRailSection title="Owner">
              <DetailRailItem label="Company" value="Acme Schools" />
            </DetailRailSection>
          </CardContent>
        </Card>
      }
    >
      <p>Example shell body</p>
    </DetailPageShell>
  );
}
