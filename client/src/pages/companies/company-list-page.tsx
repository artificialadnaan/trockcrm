import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Building2, ChevronLeft, ChevronRight, Globe2, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { listPaginationIconButtonClassName } from "@/components/shared/list-pagination";
import { MetricCard } from "@/components/shared/metric-card";
import { OwnerAssignmentControl } from "@/components/shared/owner-assignment-control";
import { OwnerLabel } from "@/components/shared/owner-label";
import { ScopeToggle } from "@/components/shared/scope-toggle";
import { USD, USD_COMPACT } from "@/components/shared/formatters";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useOwnerAssignees } from "@/hooks/use-owner-assignees";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { assignCompanyOwnerToMe, reassignCompanyOwner, useCompanies, type Company } from "@/hooks/use-companies";
import { useKeepPreviousData } from "@/hooks/use-keep-previous-data";
import { FilterBar, type FilterBarOptions, type FilterDimension } from "@/components/filters/filter-bar";
import { useFilterState } from "@/components/filters/use-filter-state";
import type { FilterBarValue } from "@/components/filters/filterbar-params";
import {
  COMPANY_LIST_SORT_OPTIONS,
  COMPANY_VERIFICATION_STATUS_OPTIONS,
  filterBarValueToCompanyFilters,
  getCompanyDisplayDate,
} from "@/components/companies/companies-filterbar-adapter";
import { cn } from "@/lib/utils";

const INDUSTRY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "general_contractor", label: "GC" },
  { value: "property_owner", label: "Owner" },
  { value: "property_management", label: "Mgmt" },
  { value: "insurance_restoration", label: "Restoration" },
] as const;

const OWNER_SCOPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
] as const;

// Wave 2 FilterBar (companies): Owner + Date + Sort + Status (verification). Search stays the page's own
// debounced, local-state input — the companies list has a HARD no-blank / no-URL-on-type requirement
// (#520, enforced by company-list-page.search-ux.test.tsx), which the bar's URL-backed `search` dimension
// would break. Industry + the mine/all owner scope also stay page controls (Industry -> the generic enum
// dimension is deferred to Wave 2.5). Render order is fixed by the bar: Date, Owner, Status, Sort.
const COMPANY_FILTER_DIMENSIONS: FilterDimension[] = ["rep", "date", "sort", "status"];
// Namespace this surface's FilterBar params (per the Wave 2 mount plan). Bare would also be collision-free
// (the companies route has no co-mounted board), but a prefix keeps the params self-describing + future-proof.
const COMPANIES_FILTER_PREFIX = "co_";

function numeric(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "TR";
}

function formatLastActivity(value: string | null | undefined) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isStale(value: string | null | undefined) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() > 30 * 24 * 60 * 60 * 1000;
}

function companyLocation(company: Company) {
  return [company.city, company.state].filter(Boolean).join(", ");
}

function CompanyStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="font-black tabular-nums text-slate-950">{value}</dd>
    </div>
  );
}

/**
 * Mobile (<md) card representation of a company row. Desktop keeps the table at
 * >=md; this is the stack-to-card fallback so phones get no horizontal-scroll
 * wall. Stretched-link pattern: the name <Link> covers the whole card (`after:
 * absolute after:inset-0`); only the interactive owner control is raised (`z-10`)
 * so it stays tappable while the rest of the card navigates to the company.
 */
export function CompanyCard({
  company,
  ownerSlot,
}: {
  company: Company;
  ownerSlot?: ReactNode;
}) {
  const stale = isStale(company.lastActivityAt);
  const location = companyLocation(company);
  const activeDeals = company.activeDealsCount ?? company.dealCount;
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-black text-white">
          {initials(company.name)}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/companies/${company.id}`}
            className="block truncate text-sm font-black uppercase text-slate-950 after:absolute after:inset-0"
          >
            {company.name}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            {location ? <span>{location}</span> : null}
            {company.domain ? (
              <span className="inline-flex items-center gap-1 font-mono">
                <Globe2 className="h-3 w-3" />
                {company.domain}
              </span>
            ) : null}
          </div>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-400" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <CompanyStat label="Properties" value={String(company.propertiesCount ?? 0)} />
        <CompanyStat label="Contacts" value={String(company.contactsCount ?? company.contactCount ?? 0)} />
        <CompanyStat label="Active deals" value={`${activeDeals}/${company.dealCount}`} />
        <CompanyStat label="Pipeline" value={USD(numeric(company.pipelineValue))} />
      </dl>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Last activity</span>
        <span className={cn("text-xs font-bold", stale ? "text-brand-red" : "text-slate-600")}>
          {formatLastActivity(getCompanyDisplayDate(company))}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <OwnerLabel ownerId={company.ownerUserId} ownerName={company.ownerUserName} />
        {ownerSlot ? <div className="relative z-10">{ownerSlot}</div> : null}
      </div>
    </div>
  );
}

export function CompanyListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { assignees, loading: assigneesLoading } = useTaskAssignees();
  const { assignees: ownerAssignees, loading: ownerAssigneesLoading } = useOwnerAssignees();
  const { filters, setFilters, resetFilters } = useFilterState(COMPANIES_FILTER_PREFIX);
  const [search, setSearch] = useState("");
  const [industry, setIndustry] = useState<(typeof INDUSTRY_OPTIONS)[number]["value"]>("all");
  const [page, setPage] = useState(1);

  // A bar filter change (Owner/Date/Sort/Status, or the page's mine/all scope writing the URL `scope`)
  // resets to page 1 — mirroring the search/industry page controls.
  const handleFilterChange = useCallback(
    (patch: Partial<FilterBarValue>) => {
      setFilters(patch);
      setPage(1);
    },
    [setFilters]
  );
  const handleResetFilters = useCallback(() => {
    resetFilters();
    setIndustry("all");
    setPage(1);
  }, [resetFilters]);

  const ownerOptions = useMemo(
    () => ownerAssignees.map((owner) => ({ value: owner.id, label: owner.displayName })),
    [ownerAssignees]
  );
  const companyFilterBarOptions = useMemo<FilterBarOptions>(
    () => ({
      reps: ownerOptions,
      sortOptions: COMPANY_LIST_SORT_OPTIONS,
      statusOptions: COMPANY_VERIFICATION_STATUS_OPTIONS,
      allowUnassigned: true,
      repLabel: "Owner",
    }),
    [ownerOptions]
  );
  // The mine/all scope is inherited via the URL `scope` (not a bar dimension); only "mine" maps to
  // ownerScope (adapter). Defaults to "all" (the companies default), not the bar's "mine".
  const ownerScopeValue = filters.scope === "mine" ? "mine" : "all";

  const { companies: rawCompanies, pagination, loading, error, refetch } = useCompanies({
    ...filterBarValueToCompanyFilters(filters),
    search: search || undefined,
    industry: industry === "all" ? undefined : industry,
    page,
    limit: 50,
  });
  // No-blank: keep the prior page of accounts visible during a search/filter/page refetch; gate
  // the skeleton to the FIRST load only and show an "Updating..." hint on a refresh.
  const { data: companies, isInitialLoading, isRefreshing } = useKeepPreviousData(rawCompanies, loading, error);

  const totals = useMemo(() => {
    const pipeline = companies.reduce((sum, company) => sum + numeric(company.pipelineValue), 0);
    const stale = companies.filter((company) => isStale(company.lastActivityAt)).length;
    const activeDeals = companies.reduce((sum, company) => sum + (company.activeDealsCount ?? company.dealCount ?? 0), 0);
    return { pipeline, stale, activeDeals };
  }, [companies]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Companies"
        description="Accounts, owners, contractors, and partner firms tied to active roofing work."
        meta={`${pagination.total} account${pagination.total === 1 ? "" : "s"}`}
        actions={{
          primary: (
            <Button onClick={() => navigate("/companies/new")}>
              <Plus className="mr-2 h-4 w-4" />
              New Company
            </Button>
          ),
        }}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard eyebrow="Total accounts" value={String(pagination.total)} badge={`${companies.length} shown`} caption="Directory" tone="green" accent="red" />
        <MetricCard eyebrow="Active pipeline" value={USD_COMPACT(totals.pipeline)} badge={`${totals.activeDeals} active deals`} caption="Open value" tone="blue" accent="blue" />
        <MetricCard eyebrow="Untouched 30d+" value={String(totals.stale)} badge="Review" caption="Needs touch" tone="red" accent="red" />
      </div>

      <Card className="border-slate-200 bg-white shadow-none">
        <CardContent className="space-y-4 p-4">
          <div className="space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
                <SearchInput
                  value={search}
                  onChange={(value) => {
                    setSearch(value);
                    setPage(1);
                  }}
                  placeholder="Search accounts, cities, domains..."
                  aria-label="Search accounts"
                  className="min-w-[240px] flex-1"
                  inputClassName="h-9 border-slate-200"
                />
                <ScopeToggle
                  options={INDUSTRY_OPTIONS}
                  value={industry}
                  onChange={(value) => {
                    setIndustry(value);
                    setPage(1);
                  }}
                  ariaLabel="Industry filter"
                  size="touch"
                />
                <ScopeToggle
                  options={OWNER_SCOPE_OPTIONS}
                  value={ownerScopeValue}
                  onChange={(value) => handleFilterChange({ scope: value === "mine" ? "mine" : undefined })}
                  ariaLabel="Ownership filter"
                  size="touch"
                />
              </div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
                {isInitialLoading ? "Loading accounts" : `${pagination.total} results${isRefreshing ? " · Updating..." : ""}`}
              </p>
            </div>
            {/* Wave 2 shared FilterBar: Owner + Date + Sort + Status (verification). Search/Industry/scope
                stay page controls above (see COMPANY_FILTER_DIMENSIONS). */}
            <FilterBar
              dimensions={COMPANY_FILTER_DIMENSIONS}
              options={companyFilterBarOptions}
              value={filters}
              onChange={handleFilterChange}
              onReset={handleResetFilters}
              // Companies have no Won/Lost or open-stage semantics; `true` suppresses the deal-specific
              // "Won/Lost & activity · open stages show current state" note the shared date control shows
              // when false (the axis is COALESCE(last_activity_at, created_at) per the contract).
              // TODO(RED): a per-surface date-note opt-out so non-deal mounts need not lean on this flag.
              stageEntryDateEnabled
            />
          </div>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>
          ) : null}

          {isInitialLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-16 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : companies.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 px-6 py-14 text-center">
              <Building2 className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-base font-black uppercase text-slate-950">No companies match this view</p>
              <p className="mt-1 text-sm text-slate-500">Clear the search or switch the filters.</p>
            </div>
          ) : (
            <>
            {/* >=md keeps the full table; phones get the stacked card list (md:hidden) below. */}
            <div className="hidden md:block"><Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Company</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Owner</TableHead>
                  <TableHead className="text-right text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Properties</TableHead>
                  <TableHead className="text-right text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Contacts</TableHead>
                  <TableHead className="text-right text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Active deals</TableHead>
                  <TableHead className="text-right text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Pipeline</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Last activity</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.map((company) => {
                  const stale = isStale(company.lastActivityAt);
                  return (
                    <TableRow
                      key={company.id}
                      className="cursor-pointer border-slate-100"
                      onClick={() => navigate(`/companies/${company.id}`)}
                    >
                      <TableCell className="min-w-[260px] py-3">
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-black text-white">
                            {initials(company.name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-black uppercase text-slate-950">{company.name}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              {companyLocation(company) ? <span>{companyLocation(company)}</span> : null}
                              {company.domain ? (
                                <span className="inline-flex items-center gap-1 font-mono">
                                  <Globe2 className="h-3 w-3" />
                                  {company.domain}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-2">
                          <OwnerLabel ownerId={company.ownerUserId} ownerName={company.ownerUserName} />
                          <OwnerAssignmentControl
                            ownerUserId={company.ownerUserId}
                            currentUser={user}
                            assignees={assignees}
                            ownerReassignAssignees={ownerAssignees}
                            assigneesLoading={assigneesLoading}
                            ownerReassignAssigneesLoading={ownerAssigneesLoading}
                            entityLabel="company"
                            onAssignToMe={() => assignCompanyOwnerToMe(company.id)}
                            onReassign={(ownerUserId) => reassignCompanyOwner(company.id, ownerUserId)}
                            onAssigned={refetch}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-black tabular-nums">{company.propertiesCount ?? 0}</TableCell>
                      <TableCell className="text-right font-black tabular-nums">{company.contactsCount ?? company.contactCount}</TableCell>
                      <TableCell className="text-right">
                        <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-black text-brand-red ring-1 ring-red-100">
                          {(company.activeDealsCount ?? company.dealCount)}/{company.dealCount}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-black tabular-nums text-slate-950">{USD(numeric(company.pipelineValue))}</TableCell>
                      <TableCell>
                        <span className={cn("text-xs font-bold", stale ? "text-brand-red" : "text-slate-600")}>
                          {formatLastActivity(getCompanyDisplayDate(company))}
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
            <div className="space-y-2 md:hidden" data-testid="company-cards">
              {companies.map((company) => (
                <CompanyCard
                  key={company.id}
                  company={company}
                  ownerSlot={
                    <OwnerAssignmentControl
                      ownerUserId={company.ownerUserId}
                      currentUser={user}
                      assignees={assignees}
                      ownerReassignAssignees={ownerAssignees}
                      assigneesLoading={assigneesLoading}
                      ownerReassignAssigneesLoading={ownerAssigneesLoading}
                      entityLabel="company"
                      onAssignToMe={() => assignCompanyOwnerToMe(company.id)}
                      onReassign={(ownerUserId) => reassignCompanyOwner(company.id, ownerUserId)}
                      onAssigned={refetch}
                    />
                  }
                />
              ))}
            </div>
            </>
          )}
        </CardContent>
      </Card>

      {pagination.totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-500">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              className={cn(listPaginationIconButtonClassName, "size-11 md:size-8")}
              disabled={pagination.page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              aria-label="Previous companies page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={cn(listPaginationIconButtonClassName, "size-11 md:size-8")}
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage((value) => Math.min(pagination.totalPages, value + 1))}
              aria-label="Next companies page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
