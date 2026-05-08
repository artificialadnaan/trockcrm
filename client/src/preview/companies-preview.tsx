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
  Building2,
  ExternalLink,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, USD_COMPACT, MetricCard, ScopeToggle } from "./preview-shared";

const INDUSTRY_OPTIONS = [
  "School District",
  "Healthcare",
  "Industrial",
  "Office / Mixed",
  "Retail",
  "Government",
  "Hospitality",
] as const;
type Industry = (typeof INDUSTRY_OPTIONS)[number];

type CompanyRow = {
  id: string;
  name: string;
  industry: Industry;
  region: string;
  contactCount: number;
  propertyCount: number;
  activeDealCount: number;
  activeDealValue: number;
  lastActivity: string;
  staleDays: number;
  ownerInitials: string;
  ownerName: string;
};

const companies: CompanyRow[] = [
  { id: "1", name: "Dallas Independent SD", industry: "School District", region: "Dallas, TX", contactCount: 8, propertyCount: 14, activeDealCount: 3, activeDealValue: 1_240_000, lastActivity: "2 days ago", staleDays: 2, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "2", name: "Frisco Logistics Co.", industry: "Industrial", region: "Frisco, TX", contactCount: 4, propertyCount: 6, activeDealCount: 2, activeDealValue: 1_120_000, lastActivity: "today", staleDays: 0, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "3", name: "Westlake Holdings", industry: "Industrial", region: "Westlake, TX", contactCount: 3, propertyCount: 9, activeDealCount: 1, activeDealValue: 410_000, lastActivity: "yesterday", staleDays: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "4", name: "Plano Tower LP", industry: "Office / Mixed", region: "Plano, TX", contactCount: 5, propertyCount: 2, activeDealCount: 1, activeDealValue: 320_000, lastActivity: "yesterday", staleDays: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "5", name: "City of Arlington", industry: "Government", region: "Arlington, TX", contactCount: 11, propertyCount: 23, activeDealCount: 1, activeDealValue: 540_000, lastActivity: "3 days ago", staleDays: 3, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "6", name: "McKinney Health Group", industry: "Healthcare", region: "McKinney, TX", contactCount: 6, propertyCount: 4, activeDealCount: 0, activeDealValue: 0, lastActivity: "1 month ago", staleDays: 32, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "7", name: "Carrollton Properties", industry: "Industrial", region: "Carrollton, TX", contactCount: 4, propertyCount: 8, activeDealCount: 1, activeDealValue: 680_000, lastActivity: "yesterday", staleDays: 1, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "8", name: "Mesquite RE Trust", industry: "Retail", region: "Mesquite, TX", contactCount: 3, propertyCount: 5, activeDealCount: 0, activeDealValue: 0, lastActivity: "5 days ago", staleDays: 5, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "9", name: "Garland Industrial", industry: "Industrial", region: "Garland, TX", contactCount: 2, propertyCount: 3, activeDealCount: 1, activeDealValue: 305_000, lastActivity: "today", staleDays: 0, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "10", name: "Allen ISD", industry: "School District", region: "Allen, TX", contactCount: 9, propertyCount: 18, activeDealCount: 1, activeDealValue: 2_240_000, lastActivity: "1 week ago", staleDays: 7, ownerInitials: "BR", ownerName: "Brett Rios" },
  { id: "11", name: "Lewisville Realty", industry: "Office / Mixed", region: "Lewisville, TX", contactCount: 3, propertyCount: 2, activeDealCount: 0, activeDealValue: 0, lastActivity: "6 weeks ago", staleDays: 42, ownerInitials: "BR", ownerName: "Brett Rios" },
];

function CompanyAvatar({ name }: { name: string }) {
  const initials = name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-900 text-[11px] font-black uppercase text-white">
      {initials}
    </div>
  );
}

function IndustryPill({ industry }: { industry: Industry }) {
  const tones: Record<Industry, string> = {
    "School District": "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    Healthcare: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    Industrial: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    "Office / Mixed": "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
    Retail: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
    Government: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
    Hospitality: "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${tones[industry]}`}>
      {industry}
    </span>
  );
}

export function CompaniesPreview() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"Mine" | "Team" | "All">("Mine");
  const [selected, setSelected] = useState<Industry[]>([]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return companies.filter((c) => {
      if (selected.length > 0 && !selected.includes(c.industry)) return false;
      if (scope === "Mine" && c.ownerInitials !== "BR") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.region.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [scope, selected, search]);

  const totalActiveValue = filtered.reduce((s, c) => s + c.activeDealValue, 0);
  const activeAccounts = filtered.filter((c) => c.activeDealCount > 0).length;
  const stale = filtered.filter((c) => c.staleDays >= 30).length;

  const toggle = (i: Industry) => {
    setSelected((current) => (current.includes(i) ? current.filter((s) => s !== i) : [...current, i]));
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Companies</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            Account directory · {filtered.length} of {companies.length}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeToggle options={["Mine", "Team", "All"] as const} value={scope} onChange={setScope} />
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            New company
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Total accounts"
          value={String(filtered.length)}
          badge={`${activeAccounts} active`}
          badgeTone="green"
          caption="In book"
          accent="red"
        />
        <MetricCard
          eyebrow="Active pipeline"
          value={USD_COMPACT(totalActiveValue)}
          badge={`${filtered.reduce((s, c) => s + c.activeDealCount, 0)} deals`}
          badgeTone="blue"
          caption="Linked to companies"
          accent="blue"
        />
        <MetricCard
          eyebrow="Untouched 30d+"
          value={String(stale)}
          badge="needs outreach"
          drenched
          caption={stale > 0 ? "going cold" : "all warm"}
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
                placeholder="Search companies or regions"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Filter className="h-4 w-4" />
              Region
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
          <p className={`${EYEBROW} self-center`}>Industry:</p>
          {INDUSTRY_OPTIONS.map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggle(i)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                selected.includes(i) ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {i}
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
                    Company
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-5 py-3 text-left">Industry</th>
                <th className="px-5 py-3 text-right">
                  <Building2 className="ml-auto h-3 w-3" aria-label="Properties" />
                </th>
                <th className="px-5 py-3 text-right">Contacts</th>
                <th className="px-5 py-3 text-right">Active deals</th>
                <th className="px-5 py-3 text-right">Pipeline</th>
                <th className="px-5 py-3 text-left">Last activity</th>
                <th className="px-5 py-3 text-left">Owner</th>
                <th className="w-10 px-5 py-3" aria-hidden />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((c) => {
                const isStale = c.staleDays >= 30;
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/companies/${c.id}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <CompanyAvatar name={c.name} />
                        <div className="min-w-0">
                          <p className="font-bold text-slate-950">{c.name}</p>
                          <p className="mt-0.5 text-xs text-slate-500">{c.region}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <IndustryPill industry={c.industry} />
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-semibold tabular-nums text-slate-700">
                      {c.propertyCount}
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-semibold tabular-nums text-slate-700">
                      {c.contactCount}
                    </td>
                    <td className="px-5 py-4 text-right">
                      {c.activeDealCount > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-700 ring-1 ring-emerald-200">
                          {c.activeDealCount}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-black tabular-nums text-slate-950">
                      {c.activeDealValue > 0 ? USD_COMPACT(c.activeDealValue) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-4">
                      <span className={`text-sm ${isStale ? "font-bold text-brand-red" : "text-slate-600"}`}>
                        {c.lastActivity}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-red text-[10px] font-black uppercase text-white">
                          {c.ownerInitials}
                        </span>
                        <span className="text-sm text-slate-700">{c.ownerName}</span>
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
                  <td colSpan={9} className="px-5 py-12 text-center text-sm text-slate-500">
                    No companies match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
          <div className="flex items-center gap-3">
            <p>
              <span className="font-bold tabular-nums text-slate-950">{filtered.length}</span> of{" "}
              <span className="tabular-nums">{companies.length}</span>
            </p>
            <span aria-hidden className="text-slate-300">
              ·
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red"
            >
              Open in HubSpot
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
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
