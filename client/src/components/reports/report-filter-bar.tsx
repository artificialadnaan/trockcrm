import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAccessibleOffices } from "@/hooks/use-accessible-offices";
import { useSalesReps } from "@/hooks/use-sales-reps";

const DATE_RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
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
  ownerNames: string[];
  ownerEmails: string[];
}

export interface ReportOwnerOption {
  id: string;
  displayName: string;
  email?: string | null;
}

type DefaultRange = "30" | "60" | "90" | "6m" | "12m" | "qtd" | "ytd";

function toDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function subtractMonthsClamped(date: Date, months: number) {
  const targetMonthIndex = date.getMonth() - months;
  const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  return new Date(
    targetYear,
    normalizedMonth,
    Math.min(date.getDate(), lastDayOfTargetMonth),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

function rangeDates(range: string) {
  const today = new Date();
  const from = new Date(today);

  if (range === "6m") {
    return { dateFrom: toDateInput(subtractMonthsClamped(today, 6)), dateTo: toDateInput(today) };
  }
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
  return { dateFrom: toDateInput(subtractMonthsClamped(today, 12)), dateTo: toDateInput(today) };
}

function defaultFilters(defaultRange: DefaultRange = "90"): ReportFilters {
  const dates = rangeDates(defaultRange);
  return { range: defaultRange, ...dates, office: "all", ownerIds: [], ownerNames: [], ownerEmails: [] };
}

function splitParam(value: string | null) {
  return value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
}

export function hydrateOwnerSelection(filters: ReportFilters, owners: ReportOwnerOption[]) {
  const ownerIds = new Set(filters.ownerIds);
  const matchedNameIndexes = new Set<number>();

  for (const email of filters.ownerEmails) {
    const owner = owners.find((entry) => entry.email?.toLowerCase() === email.toLowerCase());
    if (owner) ownerIds.add(owner.id);
  }

  filters.ownerNames.forEach((name, index) => {
    const hasEmailForSelection = Boolean(filters.ownerEmails[index]);
    if (hasEmailForSelection) return;
    const owner = owners.find((entry) => entry.displayName === name);
    if (owner) {
      ownerIds.add(owner.id);
      matchedNameIndexes.add(index);
    }
  });

  return {
    ...filters,
    ownerIds: Array.from(ownerIds),
    ownerNames: filters.ownerNames.filter((_, index) => !filters.ownerEmails[index] || matchedNameIndexes.has(index)),
  };
}

export function useReportFilters(options: { defaultRange?: DefaultRange } = {}) {
  const [searchParams] = useSearchParams();
  const filters = useMemo<ReportFilters>(() => {
    const defaults = defaultFilters(options.defaultRange);
    const range = searchParams.get("range") || defaults.range;
    return {
      range,
      dateFrom: searchParams.get("dateFrom") || defaults.dateFrom,
      dateTo: searchParams.get("dateTo") || defaults.dateTo,
      office: searchParams.get("office") || defaults.office,
      ownerIds: splitParam(searchParams.get("ownerIds")),
      ownerNames: splitParam(searchParams.get("owners") ?? searchParams.get("ownerNames")),
      ownerEmails: splitParam(searchParams.get("ownerEmails")),
    };
  }, [options.defaultRange, searchParams]);

  return {
    filters,
    query: {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      office: filters.office,
      ownerIds: filters.ownerIds,
      ownerNames: filters.ownerNames,
      ownerEmails: filters.ownerEmails,
    },
  };
}

export function ReportFilterBar({ defaultRange = "90" }: { defaultRange?: DefaultRange } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { filters } = useReportFilters({ defaultRange });
  const [draft, setDraft] = useState<ReportFilters>(filters);
  const { offices } = useAccessibleOffices();
  const canonicalOfficeId = useMemo(() => {
    if (!draft.office || draft.office === "all") return undefined;
    return offices.find((office) => office.id === draft.office || office.slug === draft.office)?.id;
  }, [draft.office, offices]);
  const { salesReps } = useSalesReps(canonicalOfficeId);

  useEffect(() => {
    setDraft(hydrateOwnerSelection(filters, salesReps));
  }, [filters, salesReps]);

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

    if (nextFilters.ownerIds.length || nextFilters.ownerNames.length || nextFilters.ownerEmails.length) {
      const selectedOwners = nextFilters.ownerIds.length && salesReps.length
        ? salesReps.filter((owner) => nextFilters.ownerIds.includes(owner.id))
        : [];
      const existingOwnerEmails = splitParam(searchParams.get("ownerEmails"));
      const names = selectedOwners.length ? selectedOwners.map((owner) => owner.displayName) : nextFilters.ownerNames;
      const emails = selectedOwners.length
        ? selectedOwners.map((owner) => owner.email).filter((email): email is string => Boolean(email))
        : nextFilters.ownerEmails.length
          ? nextFilters.ownerEmails
          : existingOwnerEmails;
      if (nextFilters.ownerIds.length) next.set("ownerIds", nextFilters.ownerIds.join(","));
      else next.delete("ownerIds");
      next.set("owners", names.join(","));
      next.delete("ownerNames");
      if (emails.length) next.set("ownerEmails", emails.join(","));
      else next.delete("ownerEmails");
    } else {
      next.delete("owners");
      next.delete("ownerNames");
      next.delete("ownerEmails");
      next.delete("ownerIds");
    }
    setSearchParams(next, { replace: false });
  }

  function resetFilters() {
    const defaults = defaultFilters(defaultRange);
    setDraft(defaults);
    applyFilters(defaults);
  }

  function toggleOwner(ownerId: string, checked: boolean | "indeterminate") {
    const owner = salesReps.find((entry) => entry.id === ownerId);
    setDraft((current) => ({
      ...current,
      ownerIds: checked === true
        ? Array.from(new Set([...current.ownerIds, ownerId]))
        : current.ownerIds.filter((id) => id !== ownerId),
      ownerNames: checked === true
        ? Array.from(new Set([...current.ownerNames, owner?.displayName].filter(Boolean) as string[]))
        : current.ownerNames.filter((name) => name !== owner?.displayName),
      ownerEmails: checked === true
        ? Array.from(new Set([...current.ownerEmails, owner?.email].filter(Boolean) as string[]))
        : current.ownerEmails.filter((email) => email !== owner?.email),
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
            onChange={(event) => setDraft((current) => ({
              ...current,
              office: event.target.value,
              ownerIds: [],
              ownerNames: [],
              ownerEmails: [],
            }))}
            className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700"
          >
            <option value="all">All offices</option>
            {offices.map((office) => (
              <option key={office.id} value={office.slug}>{office.name}</option>
            ))}
            {offices.length === 0 ? (
              <>
                <option value="dallas">Dallas</option>
                <option value="atlanta">Atlanta</option>
              </>
            ) : null}
          </select>
        </label>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-700">Owner</p>
          <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-2">
            {salesReps.length === 0 ? (
              <span className="text-xs font-medium text-slate-500">All owners</span>
            ) : salesReps.map((owner) => (
              <label key={owner.id} className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                <Checkbox
                  checked={draft.ownerIds.includes(owner.id) || draft.ownerEmails.includes(owner.email ?? "") || draft.ownerNames.includes(owner.displayName)}
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
