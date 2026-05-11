import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAccessibleOffices } from "@/hooks/use-accessible-offices";
import { api } from "@/lib/api";

// Local Tier 3 copy. Deduplicate with the shared reports filter bar if Tier 1 or Tier 2 merges first.
const DATE_RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "qtd", label: "QTD" },
  { value: "ytd", label: "YTD" },
  { value: "custom", label: "Custom" },
] as const;

export interface ReportFilters {
  range: string;
  dateFrom: string;
  dateTo: string;
  office: string;
  ownerIds: string[];
}

interface SalesRepOption {
  id: string;
  displayName: string;
}

function toDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function rangeDates(range: string) {
  const today = new Date();
  const from = new Date(today);
  if (range === "30" || range === "60" || range === "90") {
    from.setDate(today.getDate() - Number(range));
    return { dateFrom: toDateInput(from), dateTo: toDateInput(today) };
  }
  if (range === "qtd") {
    const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
    return { dateFrom: toDateInput(new Date(today.getFullYear(), quarterStartMonth, 1)), dateTo: toDateInput(today) };
  }
  if (range === "ytd") {
    return { dateFrom: `${today.getFullYear()}-01-01`, dateTo: toDateInput(today) };
  }
  from.setDate(today.getDate() - 90);
  return { dateFrom: toDateInput(from), dateTo: toDateInput(today) };
}

function defaultFilters(): ReportFilters {
  const dates = rangeDates("90");
  return { range: "90", ...dates, office: "all", ownerIds: [] };
}

export function useReportFilters() {
  const [searchParams] = useSearchParams();
  const filters = useMemo<ReportFilters>(() => {
    const defaults = defaultFilters();
    const range = searchParams.get("range") || defaults.range;
    const ownerIds = searchParams.get("ownerIds")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    return {
      range,
      dateFrom: searchParams.get("dateFrom") || defaults.dateFrom,
      dateTo: searchParams.get("dateTo") || defaults.dateTo,
      office: searchParams.get("office") || defaults.office,
      ownerIds,
    };
  }, [searchParams]);

  return {
    filters,
    query: {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      office: filters.office,
      ownerIds: filters.ownerIds,
    },
  };
}

export function ReportFilterBar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { filters } = useReportFilters();
  const [draft, setDraft] = useState<ReportFilters>(filters);
  const [owners, setOwners] = useState<SalesRepOption[]>([]);
  const { offices } = useAccessibleOffices();

  useEffect(() => {
    setDraft(filters);
  }, [filters]);

  useEffect(() => {
    let alive = true;
    api<{ users: SalesRepOption[] }>("/users/sales-reps")
      .then((data) => {
        if (alive) setOwners(data.users);
      })
      .catch(() => {
        if (alive) setOwners([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  function updateRange(range: string) {
    const dates = range === "custom" ? { dateFrom: draft.dateFrom, dateTo: draft.dateTo } : rangeDates(range);
    setDraft((current) => ({ ...current, range, ...dates }));
  }

  function applyFilters(nextFilters = draft) {
    const next = new URLSearchParams(searchParams);
    next.set("range", nextFilters.range);
    next.set("dateFrom", nextFilters.dateFrom);
    next.set("dateTo", nextFilters.dateTo);
    if (nextFilters.office && nextFilters.office !== "all") next.set("office", nextFilters.office);
    else next.delete("office");
    if (nextFilters.ownerIds.length) next.set("ownerIds", nextFilters.ownerIds.join(","));
    else next.delete("ownerIds");
    setSearchParams(next, { replace: false });
  }

  function resetFilters() {
    const defaults = defaultFilters();
    setDraft(defaults);
    applyFilters(defaults);
  }

  function toggleOwner(ownerId: string, checked: boolean | "indeterminate") {
    setDraft((current) => ({
      ...current,
      ownerIds: checked === true
        ? Array.from(new Set([...current.ownerIds, ownerId]))
        : current.ownerIds.filter((id) => id !== ownerId),
    }));
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-brand-red">Report Filters</p>
            <p className="text-sm text-slate-500">Date range, office, and owner filters persist in the URL.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={resetFilters}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button type="button" size="sm" className="bg-brand-red text-white hover:bg-brand-red/90" onClick={() => applyFilters()}>
            Apply
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[180px_160px_160px_220px_minmax(240px,1fr)]">
        <label className="space-y-1 text-sm font-semibold text-slate-700">
          Date range
          <select
            value={draft.range}
            onChange={(event) => updateRange(event.target.value)}
            className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700"
          >
            {DATE_RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm font-semibold text-slate-700">
          From
          <Input
            type="date"
            value={draft.dateFrom}
            onChange={(event) => setDraft((current) => ({ ...current, range: "custom", dateFrom: event.target.value }))}
            className="h-10"
          />
        </label>
        <label className="space-y-1 text-sm font-semibold text-slate-700">
          To
          <Input
            type="date"
            value={draft.dateTo}
            onChange={(event) => setDraft((current) => ({ ...current, range: "custom", dateTo: event.target.value }))}
            className="h-10"
          />
        </label>
        <label className="space-y-1 text-sm font-semibold text-slate-700">
          Office
          <select
            value={draft.office}
            onChange={(event) => setDraft((current) => ({ ...current, office: event.target.value }))}
            className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700"
          >
            <option value="all">All offices</option>
            {offices.map((office) => (
              <option key={office.id} value={office.id}>{office.name}</option>
            ))}
          </select>
        </label>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-700">Owner</p>
          <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-2">
            {owners.length === 0 ? (
              <span className="text-xs font-medium text-slate-500">All owners</span>
            ) : owners.map((owner) => (
              <label key={owner.id} className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                <Checkbox
                  checked={draft.ownerIds.includes(owner.id)}
                  onCheckedChange={(checked) => toggleOwner(owner.id, checked)}
                  className="h-3.5 w-3.5"
                />
                {owner.displayName}
              </label>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
