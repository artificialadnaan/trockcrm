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
  GripVertical,
  MoreHorizontal,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";

const USD = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);

const USD_COMPACT = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(
    value
  );

const DEAL_STAGES = [
  { slug: "opportunity", label: "Opportunity" },
  { slug: "estimating", label: "Estimating" },
  { slug: "estimate_under_review", label: "Estimate Under Review" },
  { slug: "estimate_sent_to_client", label: "Estimate Sent to Client" },
  { slug: "contract", label: "Contract" },
  { slug: "won", label: "Won" },
  { slug: "lost", label: "Lost" },
] as const;

type DealStageSlug = (typeof DEAL_STAGES)[number]["slug"];

const stageVariant: Record<DealStageSlug, "blue" | "amber" | "green" | "slate" | "red"> = {
  opportunity: "blue",
  estimating: "amber",
  estimate_under_review: "amber",
  estimate_sent_to_client: "blue",
  contract: "green",
  won: "green",
  lost: "slate",
};

type DealRow = {
  id: string;
  name: string;
  account: string;
  region: string;
  stage: DealStageSlug;
  days: number;
  sla: number;
  value: number;
  ownerInitials: string;
  ownerName: string;
  lastTouch: string;
};

const deals: DealRow[] = [
  { id: "1", name: "Westlake Industrial Park", account: "Westlake Holdings", region: "Westlake, TX", stage: "opportunity", days: 4, sla: 21, value: 410_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "today" },
  { id: "2", name: "Mesquite Retail Center", account: "Mesquite RE Trust", region: "Mesquite, TX", stage: "opportunity", days: 11, sla: 21, value: 215_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "5 days ago" },
  { id: "3", name: "Dallas ISD Roof Replacement", account: "Dallas Independent SD", region: "Dallas, TX", stage: "estimating", days: 22, sla: 14, value: 875_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "2 days ago" },
  { id: "4", name: "Plano Office Tower Re-Cover", account: "Plano Tower LP", region: "Plano, TX", stage: "estimating", days: 9, sla: 14, value: 320_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "yesterday" },
  { id: "5", name: "Carrollton Logistics Hub", account: "Carrollton Properties", region: "Carrollton, TX", stage: "estimating", days: 18, sla: 14, value: 680_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "yesterday" },
  { id: "6", name: "Frisco Distribution Center", account: "Frisco Logistics Co.", region: "Frisco, TX", stage: "estimate_under_review", days: 4, sla: 14, value: 1_120_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "today" },
  { id: "7", name: "Garland Warehouse 14", account: "Garland Industrial", region: "Garland, TX", stage: "estimate_sent_to_client", days: 7, sla: 21, value: 305_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "today" },
  { id: "8", name: "Arlington Civic Center", account: "City of Arlington", region: "Arlington, TX", stage: "contract", days: 16, sla: 14, value: 540_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "3 days ago" },
  { id: "9", name: "Allen Sports Complex", account: "Allen ISD", region: "Allen, TX", stage: "won", days: 41, sla: 90, value: 2_240_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "1 week ago" },
  { id: "10", name: "McKinney Medical Plaza", account: "McKinney Health Group", region: "McKinney, TX", stage: "won", days: 88, sla: 90, value: 1_460_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "1 week ago" },
  { id: "11", name: "Irving Storage Center", account: "Irving Self Storage Inc.", region: "Irving, TX", stage: "lost", days: 35, sla: 30, value: 220_000, ownerInitials: "BR", ownerName: "Brett Rios", lastTouch: "2 weeks ago" },
];

function StagePill({ stage }: { stage: DealStageSlug }) {
  const styles = {
    amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    slate: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
    red: "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/20",
  } as const;
  const label = DEAL_STAGES.find((s) => s.slug === stage)?.label ?? stage;
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

function KanbanCard({ deal, onOpen }: { deal: DealRow; onOpen: () => void }) {
  const overSla = deal.days > deal.sla;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-2 rounded-md border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
    >
      <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="truncate text-sm font-bold text-slate-950">{deal.name}</p>
        <p className="truncate text-xs text-slate-500">{deal.account}</p>
        <div className="flex items-center justify-between">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
            {deal.ownerInitials}
          </span>
          <p className="text-sm font-black tabular-nums text-slate-950">{USD_COMPACT(deal.value)}</p>
        </div>
        <div className="flex items-center justify-between text-[11px] font-semibold">
          <span className={`tabular-nums ${overSla ? "text-brand-red" : "text-slate-500"}`}>
            {deal.days}d in stage
          </span>
          <span className="text-slate-400">SLA {deal.sla}d</span>
        </div>
      </div>
    </button>
  );
}

function KanbanBoard({ rows, onOpen }: { rows: DealRow[]; onOpen: (id: string) => void }) {
  const grouped = DEAL_STAGES.map((stage) => {
    const cards = rows.filter((r) => r.stage === stage.slug);
    const total = cards.reduce((sum, c) => sum + c.value, 0);
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
                  {column.cards.length} · {USD_COMPACT(column.total)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-slate-700"
                  aria-label="Stage actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="flex-1 space-y-2 px-2 pb-3">
              {column.cards.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">No deals</p>
              ) : (
                column.cards.map((deal) => (
                  <KanbanCard key={deal.id} deal={deal} onOpen={() => onOpen(deal.id)} />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const CITY_COORDS: Record<string, { x: number; y: number }> = {
  "Dallas, TX": { x: 50, y: 60 },
  "Plano, TX": { x: 53, y: 32 },
  "Frisco, TX": { x: 56, y: 22 },
  "Arlington, TX": { x: 27, y: 64 },
  "Westlake, TX": { x: 33, y: 30 },
  "Mesquite, TX": { x: 67, y: 60 },
  "Allen, TX": { x: 62, y: 18 },
  "Carrollton, TX": { x: 41, y: 38 },
  "Garland, TX": { x: 63, y: 50 },
  "McKinney, TX": { x: 66, y: 13 },
  "Irving, TX": { x: 36, y: 56 },
};

function DealsMap({ rows, onOpen }: { rows: DealRow[]; onOpen: (id: string) => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const byCity = rows.reduce<Record<string, DealRow[]>>((acc, deal) => {
    if (!CITY_COORDS[deal.region]) return acc;
    if (!acc[deal.region]) acc[deal.region] = [];
    acc[deal.region].push(deal);
    return acc;
  }, {});

  return (
    <div className="relative">
      <div className="absolute left-4 top-4 z-10 max-w-xs space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Coverage</p>
        <p className="text-2xl font-black uppercase tracking-tight text-slate-950">Dallas-Fort Worth Metro</p>
        <p className="text-xs font-semibold text-slate-600 tabular-nums">
          {rows.length} active deals · {Object.keys(byCity).length} cities
        </p>
      </div>
      <svg
        viewBox="0 0 100 80"
        className="aspect-[5/4] w-full rounded-md bg-gradient-to-br from-slate-50 to-slate-100"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path d="M 5 0 L 0 0 0 5" fill="none" stroke="#e2e8f0" strokeWidth="0.1" />
          </pattern>
        </defs>
        <rect width="100" height="80" fill="url(#grid)" />
        {/* Soft "metro footprint" blob */}
        <ellipse cx="50" cy="42" rx="38" ry="30" fill="white" stroke="#cbd5e1" strokeWidth="0.3" opacity="0.7" />
        {/* Highway-like indicator lines */}
        <line x1="20" y1="50" x2="75" y2="55" stroke="#cbd5e1" strokeWidth="0.2" strokeDasharray="1,1" />
        <line x1="40" y1="15" x2="55" y2="65" stroke="#cbd5e1" strokeWidth="0.2" strokeDasharray="1,1" />

        {Object.entries(byCity).map(([city, dealList]) => {
          const coord = CITY_COORDS[city];
          if (!coord) return null;
          const totalValue = dealList.reduce((s, d) => s + d.value, 0);
          const isHovered = hovered === city;
          const radius = 1.2 + Math.min(2, dealList.length * 0.3);
          return (
            <g
              key={city}
              transform={`translate(${coord.x}, ${coord.y})`}
              onMouseEnter={() => setHovered(city)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => dealList.length === 1 && onOpen(dealList[0]!.id)}
              className="cursor-pointer"
            >
              {isHovered ? (
                <circle r={radius + 1.5} fill="#CC0000" opacity="0.2" />
              ) : null}
              <circle r={radius} fill="#CC0000" stroke="white" strokeWidth="0.4" />
              {dealList.length > 1 ? (
                <text
                  y="0.4"
                  textAnchor="middle"
                  fontSize="1.5"
                  fontWeight="900"
                  fill="white"
                >
                  {dealList.length}
                </text>
              ) : null}
              <text
                y={radius + 2.4}
                textAnchor="middle"
                fontSize="1.6"
                fontWeight="700"
                fill="#0f172a"
                className="select-none"
              >
                {city.replace(", TX", "")}
              </text>
              <text
                y={radius + 4.5}
                textAnchor="middle"
                fontSize="1.3"
                fontWeight="600"
                fill="#64748b"
                className="select-none tabular-nums"
              >
                {USD_COMPACT(totalValue)}
              </text>
            </g>
          );
        })}
      </svg>

      {hovered && byCity[hovered] ? (
        <div className="pointer-events-none absolute right-4 top-4 w-72 rounded-md border border-slate-200 bg-white p-4 shadow-lg">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">{hovered}</p>
          <p className="mt-1 text-lg font-black tracking-tight text-slate-950">
            {byCity[hovered].length} deal{byCity[hovered].length === 1 ? "" : "s"}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-slate-700 tabular-nums">
            {USD_COMPACT(byCity[hovered].reduce((s, d) => s + d.value, 0))}
          </p>
          <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
            {byCity[hovered].map((deal) => (
              <div key={deal.id} className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-semibold text-slate-700">{deal.name}</p>
                <StagePill stage={deal.stage} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const VIEWS = ["Board", "Map"] as const;
type View = (typeof VIEWS)[number];

export function DealsPreview() {
  const navigate = useNavigate();
  const [view, setView] = useState<View>("Board");
  const [scope, setScope] = useState<"Mine" | "Team" | "All">("Mine");
  const [selectedStages, setSelectedStages] = useState<DealStageSlug[]>([]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return deals.filter((deal) => {
      if (selectedStages.length > 0 && !selectedStages.includes(deal.stage)) return false;
      if (scope === "Mine" && deal.ownerInitials !== "BR") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!deal.name.toLowerCase().includes(q) && !deal.account.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [scope, selectedStages, search]);

  const totalValue = filtered.filter((d) => d.stage !== "won" && d.stage !== "lost").reduce((sum, deal) => sum + deal.value, 0);
  const wonValue = filtered.filter((d) => d.stage === "won").reduce((s, d) => s + d.value, 0);
  const overSlaCount = filtered.filter((deal) => deal.days > deal.sla && deal.stage !== "won" && deal.stage !== "lost").length;
  const activeCount = filtered.filter((d) => d.stage !== "won" && d.stage !== "lost").length;

  const toggleStage = (stage: DealStageSlug) => {
    setSelectedStages((current) =>
      current.includes(stage) ? current.filter((s) => s !== stage) : [...current, stage]
    );
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Deals</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            Active pipeline · {filtered.length} of {deals.length}
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
            New deal
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Active pipeline"
          value={USD_COMPACT(totalValue)}
          badge={`${activeCount} deals`}
          badgeTone="green"
          caption="Open"
          accent="red"
        />
        <MetricCard
          eyebrow="Won YTD"
          value={USD_COMPACT(wonValue)}
          badge={`${filtered.filter((d) => d.stage === "won").length} closed`}
          badgeTone="blue"
          caption="Closed-won value"
          accent="blue"
        />
        <MetricCard
          eyebrow="At risk"
          value={String(overSlaCount)}
          badge="needs attention"
          drenched
          caption={overSlaCount > 0 ? "over SLA" : "all on track"}
        />
      </div>

      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">
              {view === "Board" ? "Pipeline board" : "Coverage map"}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {view === "Board"
                ? "Drag to move stage · click to open"
                : "Geographic distribution · hover a pin"}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-sm px-3 py-1 text-xs font-semibold transition-colors ${
                  view === v ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        {view === "Board" ? (
          <div className="p-3">
            <KanbanBoard rows={filtered} onOpen={(id) => navigate(`/deals/${id}`)} />
          </div>
        ) : (
          <div className="p-4">
            <DealsMap rows={filtered} onOpen={(id) => navigate(`/deals/${id}`)} />
          </div>
        )}
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
                placeholder="Search deals or accounts"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Filter className="h-4 w-4" />
              Filter
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
          {DEAL_STAGES.map((stage) => (
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
                    Deal
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-left">Owner</th>
                <th className="px-5 py-3 text-left">Stage</th>
                <th className="px-5 py-3 text-right">
                  <button className="inline-flex items-center gap-1 hover:text-slate-900">
                    Days
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-right">
                  <button className="inline-flex items-center gap-1 hover:text-slate-900">
                    Value
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-left">Last touch</th>
                <th className="w-10 px-5 py-3" aria-hidden />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((deal) => {
                const overSla = deal.days > deal.sla;
                return (
                  <tr
                    key={deal.id}
                    onClick={() => navigate(`/deals/${deal.id}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-4">
                      <p className="font-bold text-slate-950">{deal.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {deal.account} · {deal.region}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                          {deal.ownerInitials}
                        </span>
                        <span className="text-sm text-slate-700">{deal.ownerName}</span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <StagePill stage={deal.stage} />
                    </td>
                    <td className="px-5 py-4 text-right tabular-nums">
                      <span className={`text-sm font-black ${overSla ? "text-brand-red" : "text-slate-950"}`}>
                        {deal.days}d
                      </span>
                      <span className="ml-1 text-xs text-slate-400">/ {deal.sla}d</span>
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                      {USD(deal.value)}
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-600">{deal.lastTouch}</td>
                    <td className="px-5 py-4 text-right">
                      <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-sm text-slate-500">
                    No deals match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
          <p>
            <span className="font-bold tabular-nums text-slate-950">{filtered.length}</span> of{" "}
            <span className="tabular-nums">{deals.length}</span>
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
