import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Plus,
  Download,
  ArrowUpDown,
  Search,
  Phone,
  Mail,
  Calendar,
  GripVertical,
  MoreHorizontal,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";

const USD_COMPACT = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(
    value
  );

const LEAD_STAGES = [
  { slug: "new_lead", label: "New Lead" },
  { slug: "qualified_lead", label: "Qualified Lead" },
  { slug: "sales_validation", label: "Sales Validation" },
] as const;

type LeadStageSlug = (typeof LEAD_STAGES)[number]["slug"];

const stageVariant: Record<LeadStageSlug, "blue" | "amber" | "green" | "slate"> = {
  new_lead: "blue",
  qualified_lead: "amber",
  sales_validation: "green",
};

const SOURCE_OPTIONS = ["Referral", "Inbound", "Outbound", "Bid Board", "Repeat"] as const;
type Source = (typeof SOURCE_OPTIONS)[number];

type LeadRow = {
  id: string;
  name: string;
  company: string;
  region: string;
  stage: LeadStageSlug;
  source: Source;
  days: number;
  staleAt: number;
  estimatedValue: number;
  ownerInitials: string;
  ownerName: string;
  lastTouch: string;
};

const leads: LeadRow[] = [
  { id: "1", name: "North Texas Distribution", company: "NTX Logistics", region: "Denton, TX", stage: "new_lead", source: "Inbound", days: 2, staleAt: 7, estimatedValue: 540_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "today" },
  { id: "2", name: "Mesquite Retail Center", company: "Mesquite RE Trust", region: "Mesquite, TX", stage: "new_lead", source: "Inbound", days: 1, staleAt: 7, estimatedValue: 215_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "today" },
  { id: "3", name: "Carrollton Logistics Hub", company: "Carrollton Properties", region: "Carrollton, TX", stage: "qualified_lead", days: 7, staleAt: 14, source: "Bid Board", estimatedValue: 680_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "yesterday" },
  { id: "4", name: "Lewisville Office Park", company: "Lewisville Realty", region: "Lewisville, TX", stage: "qualified_lead", source: "Referral", days: 5, staleAt: 14, estimatedValue: 380_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "2 days ago" },
  { id: "5", name: "Garland Warehouse 14", company: "Garland Industrial", region: "Garland, TX", stage: "qualified_lead", source: "Outbound", days: 17, staleAt: 14, estimatedValue: 305_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "1 week ago" },
  { id: "6", name: "McKinney Medical Plaza", company: "McKinney Health Group", region: "McKinney, TX", stage: "sales_validation", source: "Repeat", days: 9, staleAt: 14, estimatedValue: 1_460_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "yesterday" },
  { id: "7", name: "Westlake Industrial Park", company: "Westlake Holdings", region: "Westlake, TX", stage: "sales_validation", source: "Referral", days: 4, staleAt: 14, estimatedValue: 410_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "today" },
  { id: "8", name: "Allen Sports Complex", company: "Allen ISD", region: "Allen, TX", stage: "sales_validation", source: "Outbound", days: 28, staleAt: 21, estimatedValue: 2_240_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "5 days ago" },
];

function StagePill({ stage }: { stage: LeadStageSlug }) {
  const styles = {
    amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    slate: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
  } as const;
  const label = LEAD_STAGES.find((s) => s.slug === stage)?.label ?? stage;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${styles[stageVariant[stage]]}`}
    >
      {label}
    </span>
  );
}

function MetricCard({
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

function KanbanCard({ lead, onOpen }: { lead: LeadRow; onOpen: () => void }) {
  const isStale = lead.days > lead.staleAt;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-2 rounded-md border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
    >
      <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="truncate text-sm font-bold text-slate-950">{lead.name}</p>
        <p className="truncate text-xs text-slate-500">{lead.company}</p>
        <div className="flex items-center justify-between">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
            {lead.ownerInitials}
          </span>
          <p className="text-xs font-bold text-slate-700">{lead.source}</p>
        </div>
        <div className="flex items-center justify-between text-[11px] font-semibold">
          <span className={`tabular-nums ${isStale ? "text-brand-red" : "text-slate-500"}`}>
            {lead.days}d in stage
          </span>
          <span className="text-slate-400">~{USD_COMPACT(lead.estimatedValue)}</span>
        </div>
      </div>
    </button>
  );
}

function KanbanBoard({ rows, onOpen }: { rows: LeadRow[]; onOpen: (id: string) => void }) {
  const grouped = LEAD_STAGES.map((stage) => {
    const cards = rows.filter((r) => r.stage === stage.slug);
    const total = cards.reduce((sum, c) => sum + c.estimatedValue, 0);
    return { ...stage, cards, total };
  });
  return (
    <div className="-mx-2 overflow-x-auto px-2 pb-2">
      <div className="flex min-w-max gap-3">
        {grouped.map((column) => (
          <div key={column.slug} className="flex w-72 shrink-0 flex-col rounded-md bg-slate-100/60">
            <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
              <div className="min-w-0">
                <p className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-slate-600">
                  {column.label}
                </p>
                <p className="mt-1 text-xs font-semibold text-slate-500 tabular-nums">
                  {column.cards.length} · ~{USD_COMPACT(column.total)}
                </p>
              </div>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-slate-700"
                aria-label="Stage actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 space-y-2 px-2 pb-3">
              {column.cards.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">No leads</p>
              ) : (
                column.cards.map((lead) => (
                  <KanbanCard key={lead.id} lead={lead} onOpen={() => onOpen(lead.id)} />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LeadsPreview() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"Mine" | "Team" | "All">("Mine");
  const [selectedStages, setSelectedStages] = useState<LeadStageSlug[]>([]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return leads.filter((lead) => {
      if (selectedStages.length > 0 && !selectedStages.includes(lead.stage)) return false;
      if (scope === "Mine" && lead.ownerInitials !== "BR") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!lead.name.toLowerCase().includes(q) && !lead.company.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [scope, selectedStages, search]);

  const totalValue = filtered.reduce((sum, lead) => sum + lead.estimatedValue, 0);
  const qualifiedCount = filtered.filter((l) => l.stage === "qualified_lead" || l.stage === "sales_validation").length;
  const staleCount = filtered.filter((l) => l.days > l.staleAt).length;

  const toggleStage = (stage: LeadStageSlug) => {
    setSelectedStages((current) =>
      current.includes(stage) ? current.filter((s) => s !== stage) : [...current, stage]
    );
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Leads</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            Top of funnel · {filtered.length} of {leads.length}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1">
            {(["Mine", "Team", "All"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  scope === s ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            New lead
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Active leads"
          value={String(filtered.length)}
          badge={`${qualifiedCount} qualified+`}
          badgeTone="green"
          caption="Top of funnel"
          accent="blue"
        />
        <MetricCard
          eyebrow="Estimated value"
          value={USD_COMPACT(totalValue)}
          badge={`${USD_COMPACT(totalValue / Math.max(1, filtered.length))} avg`}
          badgeTone="blue"
          caption="If all converted"
          accent="green"
        />
        <MetricCard
          eyebrow="Stale leads"
          value={String(staleCount)}
          badge="needs follow-up"
          drenched
          caption={staleCount > 0 ? "past stale threshold" : "all fresh"}
        />
      </div>

      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Lead funnel</p>
            <p className="mt-0.5 text-xs text-slate-500">Drag to advance · click to open</p>
          </div>
        </div>
        <div className="p-3">
          <KanbanBoard rows={filtered} onOpen={(id) => navigate(`/leads/${id}`)} />
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 items-center gap-3">
            <div className="flex flex-1 items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search leads or companies"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Filter className="h-4 w-4" />
              Source
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </div>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2 border-b border-slate-100 px-5 py-3">
          <p className={`${EYEBROW} self-center`}>Stage:</p>
          {LEAD_STAGES.map((stage) => (
            <button
              key={stage.slug}
              type="button"
              onClick={() => toggleStage(stage.slug)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                selectedStages.includes(stage.slug)
                  ? "bg-brand-red text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {stage.label}
            </button>
          ))}
          {selectedStages.length > 0 ? (
            <button
              type="button"
              onClick={() => setSelectedStages([])}
              className="ml-auto text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-900"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                <th className="px-5 py-3 text-left">
                  <button className="inline-flex items-center gap-1 hover:text-slate-900">
                    Lead
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-left">Owner</th>
                <th className="px-5 py-3 text-left">Stage</th>
                <th className="px-5 py-3 text-left">Source</th>
                <th className="px-5 py-3 text-right">
                  <button className="inline-flex items-center gap-1 hover:text-slate-900">
                    Days
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-right">Est. value</th>
                <th className="px-5 py-3 text-left">Quick</th>
                <th className="w-10 px-5 py-3" aria-hidden />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((lead) => {
                const isStale = lead.days > lead.staleAt;
                return (
                  <tr
                    key={lead.id}
                    onClick={() => navigate(`/leads/${lead.id}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-4">
                      <p className="font-bold text-slate-950">{lead.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {lead.company} · {lead.region}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                          {lead.ownerInitials}
                        </span>
                        <span className="text-sm text-slate-700">{lead.ownerName}</span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <StagePill stage={lead.stage} />
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-600">{lead.source}</td>
                    <td className="px-5 py-4 text-right tabular-nums">
                      <span className={`text-sm font-black ${isStale ? "text-brand-red" : "text-slate-950"}`}>
                        {lead.days}d
                      </span>
                      <span className="ml-1 text-xs text-slate-400">{lead.lastTouch}</span>
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                      {USD_COMPACT(lead.estimatedValue)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label="Call"
                        >
                          <Phone className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label="Email"
                        >
                          <Mail className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label="Schedule"
                        >
                          <Calendar className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-slate-500">
                    No leads match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
          <p>
            <span className="font-bold tabular-nums text-slate-950">{filtered.length}</span> of{" "}
            <span className="tabular-nums">{leads.length}</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Prev
            </button>
            <button
              type="button"
              className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Next
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
