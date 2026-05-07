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
  MapPin,
  Camera,
  Building2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, USD_COMPACT, MetricCard, ScopeToggle } from "./preview-shared";

const TYPE_OPTIONS = ["Office", "Industrial", "Retail", "School", "Healthcare", "Government", "Mixed-Use"] as const;
type PropertyType = (typeof TYPE_OPTIONS)[number];

type EngagementStatus = "Active deal" | "Active lead" | "Won project" | "No engagement";

type PropertyRow = {
  id: string;
  name: string;
  address: string;
  city: string;
  type: PropertyType;
  ownerCompany: string;
  sqft: number;
  status: EngagementStatus;
  activeDealValue?: number;
  activeDealStage?: string;
  lastTouch: string;
  staleDays: number;
  hasPhotos: boolean;
};

const properties: PropertyRow[] = [
  { id: "1", name: "Building A - Main Campus", address: "9400 N Central Expy", city: "Dallas, TX", type: "School", ownerCompany: "Dallas Independent SD", sqft: 142_000, status: "Active deal", activeDealValue: 875_000, activeDealStage: "Estimating", lastTouch: "2 days ago", staleDays: 2, hasPhotos: true },
  { id: "2", name: "Frisco Distribution Center", address: "2200 Logistics Way", city: "Frisco, TX", type: "Industrial", ownerCompany: "Frisco Logistics Co.", sqft: 285_000, status: "Active deal", activeDealValue: 1_120_000, activeDealStage: "Estimate Sent", lastTouch: "today", staleDays: 0, hasPhotos: true },
  { id: "3", name: "Plano Office Tower", address: "1500 Legacy Dr", city: "Plano, TX", type: "Office", ownerCompany: "Plano Tower LP", sqft: 92_000, status: "Active deal", activeDealValue: 320_000, activeDealStage: "Estimating", lastTouch: "yesterday", staleDays: 1, hasPhotos: true },
  { id: "4", name: "Westlake Industrial Park", address: "3300 Westlake Pkwy", city: "Westlake, TX", type: "Industrial", ownerCompany: "Westlake Holdings", sqft: 220_000, status: "Active deal", activeDealValue: 410_000, activeDealStage: "Opportunity", lastTouch: "today", staleDays: 0, hasPhotos: false },
  { id: "5", name: "Arlington Civic Center", address: "100 W Abram St", city: "Arlington, TX", type: "Government", ownerCompany: "City of Arlington", sqft: 178_000, status: "Active deal", activeDealValue: 540_000, activeDealStage: "Contract", lastTouch: "3 days ago", staleDays: 3, hasPhotos: true },
  { id: "6", name: "Allen Sports Complex", address: "777 Stadium Dr", city: "Allen, TX", type: "School", ownerCompany: "Allen ISD", sqft: 220_000, status: "Won project", activeDealValue: 2_240_000, activeDealStage: "Won", lastTouch: "1 week ago", staleDays: 7, hasPhotos: true },
  { id: "7", name: "Carrollton Logistics Hub", address: "1810 Industrial Blvd", city: "Carrollton, TX", type: "Industrial", ownerCompany: "Carrollton Properties", sqft: 156_000, status: "Active deal", activeDealValue: 680_000, activeDealStage: "Estimating", lastTouch: "yesterday", staleDays: 1, hasPhotos: true },
  { id: "8", name: "Mesquite Retail Center", address: "2500 N Town East Blvd", city: "Mesquite, TX", type: "Retail", ownerCompany: "Mesquite RE Trust", sqft: 64_000, status: "Active lead", lastTouch: "5 days ago", staleDays: 5, hasPhotos: false },
  { id: "9", name: "McKinney Medical Plaza", address: "4500 Medical Dr", city: "McKinney, TX", type: "Healthcare", ownerCompany: "McKinney Health Group", sqft: 88_000, status: "No engagement", lastTouch: "1 month ago", staleDays: 32, hasPhotos: false },
  { id: "10", name: "Garland Warehouse 14", address: "12000 Industrial Pkwy", city: "Garland, TX", type: "Industrial", ownerCompany: "Garland Industrial", sqft: 96_000, status: "Active deal", activeDealValue: 305_000, activeDealStage: "Bid Submitted", lastTouch: "today", staleDays: 0, hasPhotos: true },
  { id: "11", name: "North Texas Distribution", address: "8000 NTX Pkwy", city: "Denton, TX", type: "Industrial", ownerCompany: "NTX Logistics", sqft: 412_000, status: "Active lead", lastTouch: "today", staleDays: 0, hasPhotos: false },
  { id: "12", name: "Lewisville Office Park", address: "501 Main St", city: "Lewisville, TX", type: "Office", ownerCompany: "Lewisville Realty", sqft: 54_000, status: "No engagement", lastTouch: "6 weeks ago", staleDays: 42, hasPhotos: false },
];

function TypePill({ type }: { type: PropertyType }) {
  const tones: Record<PropertyType, string> = {
    Office: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
    Industrial: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    Retail: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
    School: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    Healthcare: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    Government: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
    "Mixed-Use": "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${tones[type]}`}>
      {type}
    </span>
  );
}

function StatusPill({ status }: { status: EngagementStatus }) {
  const config: Record<EngagementStatus, { className: string; dot: string }> = {
    "Active deal": { className: "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/20", dot: "bg-brand-red" },
    "Active lead": { className: "bg-blue-50 text-blue-700 ring-1 ring-blue-200", dot: "bg-blue-500" },
    "Won project": { className: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200", dot: "bg-emerald-500" },
    "No engagement": { className: "bg-slate-100 text-slate-500 ring-1 ring-slate-200", dot: "bg-slate-400" },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${c.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
      {status}
    </span>
  );
}

export function PropertiesPreview() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"My linked" | "Team" | "All">("My linked");
  const [selected, setSelected] = useState<PropertyType[]>([]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return properties.filter((p) => {
      if (selected.length > 0 && !selected.includes(p.type)) return false;
      if (scope === "My linked" && p.status === "No engagement") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !p.name.toLowerCase().includes(q) &&
          !p.address.toLowerCase().includes(q) &&
          !p.city.toLowerCase().includes(q) &&
          !p.ownerCompany.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [scope, selected, search]);

  const totalSqft = filtered.reduce((s, p) => s + p.sqft, 0);
  const activeOpportunities = filtered.filter((p) => p.status === "Active deal" || p.status === "Active lead").length;
  const stale = filtered.filter((p) => p.staleDays >= 30).length;
  const activeValue = filtered.reduce((s, p) => s + (p.activeDealValue ?? 0), 0);

  const toggle = (t: PropertyType) => {
    setSelected((current) => (current.includes(t) ? current.filter((s) => s !== t) : [...current, t]));
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Properties</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            Real estate inventory · {filtered.length} of {properties.length}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeToggle options={["My linked", "Team", "All"] as const} value={scope} onChange={setScope} />
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            New property
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Active opportunities"
          value={String(activeOpportunities)}
          badge={`${(totalSqft / 1_000_000).toFixed(1)}M sq ft`}
          badgeTone="green"
          caption="In play"
          accent="red"
        />
        <MetricCard
          eyebrow="Linked pipeline"
          value={USD_COMPACT(activeValue)}
          badge={`${filtered.filter((p) => p.activeDealValue).length} deals`}
          badgeTone="blue"
          caption="Across properties"
          accent="blue"
        />
        <MetricCard
          eyebrow="Untouched 30d+"
          value={String(stale)}
          badge="needs walkthrough"
          drenched
          caption={stale > 0 ? "going dark" : "all engaged"}
        />
      </div>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 items-center gap-3">
            <div className="flex flex-1 items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search address, name, or owner"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Filter className="h-4 w-4" />
              City
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
          <p className={`${EYEBROW} self-center`}>Type:</p>
          {TYPE_OPTIONS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                selected.includes(t) ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {t}
            </button>
          ))}
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => setSelected([])}
              className="ml-auto text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-900"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                <th className="px-5 py-3 text-left">
                  <button className="inline-flex items-center gap-1 hover:text-slate-900">
                    Property
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-left">Type</th>
                <th className="px-5 py-3 text-left">Owner</th>
                <th className="px-5 py-3 text-right">Sq ft</th>
                <th className="px-5 py-3 text-left">Engagement</th>
                <th className="px-5 py-3 text-right">Linked value</th>
                <th className="px-5 py-3 text-left">Last touch</th>
                <th className="w-10 px-5 py-3" aria-hidden />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((p) => {
                const isStale = p.staleDays >= 30;
                return (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/properties/${p.id}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100">
                          {p.hasPhotos ? (
                            <Camera className="h-4 w-4 text-slate-600" />
                          ) : (
                            <Building2 className="h-4 w-4 text-slate-400" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-slate-950">{p.name}</p>
                          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">
                            <MapPin className="h-3 w-3 shrink-0" />
                            {p.address} · {p.city}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <TypePill type={p.type} />
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-700">{p.ownerCompany}</td>
                    <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                      {p.sqft.toLocaleString()}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-col items-start gap-1">
                        <StatusPill status={p.status} />
                        {p.activeDealStage ? (
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            {p.activeDealStage}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                      {p.activeDealValue ? USD_COMPACT(p.activeDealValue) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-4">
                      <span className={`text-sm ${isStale ? "font-bold text-brand-red" : "text-slate-600"}`}>
                        {p.lastTouch}
                      </span>
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
                    No properties match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
          <p>
            <span className="font-bold tabular-nums text-slate-950">{filtered.length}</span> of{" "}
            <span className="tabular-nums">{properties.length}</span>
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
