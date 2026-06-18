import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Building2, Camera, ChevronLeft, ChevronRight, MapPin, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { listPaginationIconButtonClassName } from "@/components/shared/list-pagination";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle } from "@/components/shared/scope-toggle";
import { NUMBER_COMPACT, USD, USD_COMPACT } from "@/components/shared/formatters";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PropertyCreateDialog } from "@/components/properties/property-create-dialog";
import { formatPropertyLabel, useProperties, type PropertySurface } from "@/hooks/use-properties";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  office: "Office",
  industrial: "Industrial",
  retail: "Retail",
  school: "School",
  healthcare: "Healthcare",
  government: "Government",
  mixed_use: "Mixed-use",
};

const TYPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "office", label: "Office" },
  { value: "industrial", label: "Industrial" },
  { value: "retail", label: "Retail" },
  { value: "school", label: "School" },
  { value: "mixed_use", label: "Mixed" },
] as const;

const ENGAGEMENT_LABELS: Record<NonNullable<PropertySurface["engagementStatus"]>, string> = {
  won: "Won project",
  active_deal: "Active deal",
  active_lead: "Active lead",
  no_engagement: "No engagement",
};

const ENGAGEMENT_CLASSES: Record<NonNullable<PropertySurface["engagementStatus"]>, string> = {
  won: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  active_deal: "bg-red-50 text-brand-red ring-red-100",
  active_lead: "bg-blue-50 text-blue-700 ring-blue-100",
  no_engagement: "bg-slate-100 text-slate-600 ring-slate-200",
};

function numeric(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function formatLastActivity(value: string | null | undefined) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isStale(value: string | null | undefined) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() > 30 * 24 * 60 * 60 * 1000;
}

function propertyArea(property: PropertySurface) {
  return property.roofArea ?? property.unitCount ?? 0;
}

function PropertyStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="font-black tabular-nums text-slate-950">{value}</dd>
    </div>
  );
}

/**
 * Mobile (<md) card representation of a property row. Desktop keeps the table at
 * >=md; this is the stack-to-card fallback so phones get no horizontal-scroll wall.
 * The row has no interactive children (it only navigates), so the whole card is a
 * single <Link> — simplest and keyboard-accessible, no stretched-link needed.
 */
export function PropertyCard({ property }: { property: PropertySurface }) {
  const engagement = property.engagementStatus ?? "no_engagement";
  const stale = isStale(property.lastActivityAt);
  const area = propertyArea(property);
  return (
    <Link to={`/properties/${property.id}`} className="block rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
          {property.photosCount ? <Camera className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black uppercase text-slate-950">{property.name || formatPropertyLabel(property)}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{formatPropertyLabel(property)}</p>
          <p className="mt-1 truncate text-xs font-semibold text-slate-600">{property.companyName ?? "Unassigned"}</p>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-400" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">
          {property.type ? TYPE_LABELS[property.type] ?? property.type : "Unclassified"}
        </span>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-black ring-1", ENGAGEMENT_CLASSES[engagement])}>
          {ENGAGEMENT_LABELS[engagement]}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <PropertyStat label="Sq ft" value={area ? NUMBER_COMPACT(area) : "None"} />
        <PropertyStat label="Linked value" value={USD(numeric(property.linkedValue ?? property.activePipelineValue))} />
      </dl>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Last touch</span>
        <span className={cn("text-xs font-bold", stale ? "text-brand-red" : "text-slate-600")}>
          {formatLastActivity(property.lastActivityAt)}
        </span>
      </div>
    </Link>
  );
}

export function PropertyListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [type, setType] = useState<(typeof TYPE_OPTIONS)[number]["value"]>("all");
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const { properties, loading, error } = useProperties({
    search: search || undefined,
    type: type === "all" ? undefined : type,
    limit: 250,
  });

  const totalPages = Math.max(1, Math.ceil(properties.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = properties.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const totals = useMemo(() => {
    const activeOpportunities = properties.reduce(
      (sum, property) => sum + property.leadCount + (property.activeDealsCount ?? property.dealCount),
      0
    );
    const linkedPipeline = properties.reduce((sum, property) => sum + numeric(property.linkedValue ?? property.activePipelineValue), 0);
    const roofArea = properties.reduce((sum, property) => sum + (property.roofArea ?? 0), 0);
    // roof_area has no writers (NULL by construction today), so the summed value is always 0. Surface
    // "No data" rather than a misleading "0 sq ft" when no property in view carries a known roof area —
    // mirrors the per-property "No data" handling on the property detail page.
    const hasRoofArea = properties.some((property) => property.roofArea != null);
    const stale = properties.filter((property) => isStale(property.lastActivityAt)).length;
    return { activeOpportunities, linkedPipeline, roofArea, hasRoofArea, stale };
  }, [properties]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Properties"
        description="Building surfaces, owner accounts, linked deals, and activity status across the portfolio."
        meta={`${properties.length} propert${properties.length === 1 ? "y" : "ies"}`}
        actions={{
          primary: (
            <PropertyCreateDialog
              triggerLabel="New Property"
              onCreated={(property) => navigate(`/properties/${property.id}`)}
            />
          ),
        }}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard eyebrow="Active opportunities" value={String(totals.activeOpportunities)} badge={totals.hasRoofArea ? `${NUMBER_COMPACT(totals.roofArea)} sq ft` : "No data"} caption="Roof area" tone="green" accent="red" />
        <MetricCard eyebrow="Linked pipeline" value={USD_COMPACT(totals.linkedPipeline)} badge={`${properties.length} sites`} caption="Active deals" tone="blue" accent="blue" />
        <MetricCard eyebrow="Untouched 30d+" value={String(totals.stale)} badge="Review" caption="Needs touch" tone="red" accent="red" />
      </div>

      <Card className="border-slate-200 bg-white shadow-none">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-1 flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative min-w-[240px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search properties, addresses, companies..."
                  className="h-9 border-slate-200 pl-9"
                />
              </div>
              <ScopeToggle
                options={TYPE_OPTIONS}
                value={type}
                onChange={(value) => {
                  setType(value);
                  setPage(1);
                }}
                ariaLabel="Property type filter"
                size="touch"
              />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
              {loading ? "Loading properties" : `${properties.length} results`}
            </p>
          </div>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
          ) : null}

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-16 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : pageItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 px-6 py-14 text-center">
              <MapPin className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-base font-black uppercase text-slate-950">No properties match this view</p>
              <p className="mt-1 text-sm text-slate-500">Clear the search or switch the type filter.</p>
            </div>
          ) : (
            <>
            {/* >=md keeps the full table; phones get the stacked card list (md:hidden) below. */}
            <div className="hidden md:block"><Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Property</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Type</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Owner company</TableHead>
                  <TableHead className="text-right text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Sq ft</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Engagement</TableHead>
                  <TableHead className="text-right text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Linked value</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Last touch</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((property) => {
                  const engagement = property.engagementStatus ?? "no_engagement";
                  const stale = isStale(property.lastActivityAt);
                  const area = propertyArea(property);
                  return (
                    <TableRow
                      key={property.id}
                      className="cursor-pointer border-slate-100"
                      onClick={() => navigate(`/properties/${property.id}`)}
                    >
                      <TableCell className="min-w-[300px] py-3">
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
                            {property.photosCount ? <Camera className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-black uppercase text-slate-950">{property.name || formatPropertyLabel(property)}</p>
                            <p className="mt-1 truncate text-xs text-slate-500">{formatPropertyLabel(property)}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">
                          {property.type ? TYPE_LABELS[property.type] ?? property.type : "Unclassified"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <p className="max-w-[220px] truncate text-sm font-semibold text-slate-700">{property.companyName ?? "Unassigned"}</p>
                      </TableCell>
                      <TableCell className="text-right font-black tabular-nums">{area ? NUMBER_COMPACT(area) : "None"}</TableCell>
                      <TableCell>
                        <span className={cn("rounded-full px-2.5 py-1 text-xs font-black ring-1", ENGAGEMENT_CLASSES[engagement])}>
                          {ENGAGEMENT_LABELS[engagement]}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-black tabular-nums text-slate-950">{USD(numeric(property.linkedValue ?? property.activePipelineValue))}</TableCell>
                      <TableCell>
                        <span className={cn("text-xs font-bold", stale ? "text-brand-red" : "text-slate-600")}>
                          {formatLastActivity(property.lastActivityAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <ArrowUpRight className="h-4 w-4 text-slate-400" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table></div>
            <div className="space-y-2 md:hidden" data-testid="property-cards">
              {pageItems.map((property) => (
                <PropertyCard key={property.id} property={property} />
              ))}
            </div>
            </>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-500">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              className={cn(listPaginationIconButtonClassName, "size-11 md:size-8")}
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              aria-label="Previous properties page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={cn(listPaginationIconButtonClassName, "size-11 md:size-8")}
              disabled={currentPage >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              aria-label="Next properties page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
