import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUpRight, Building2, ChevronLeft, ChevronRight, Globe2, Plus, X } from "lucide-react";
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

// Persistent highlight for the currently-drilled summary card (matches MetricCard's focus ring).
const ACTIVE_CARD_CLASS = "ring-2 ring-brand-red";

const COMPANY_CARD_LABELS: Record<string, string> = {
  pipeline: "Active pipeline",
  stale: "Untouched 30d+",
};

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
          {formatLastActivity(company.lastActivityAt)}
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
  const [search, setSearch] = useState("");
  const [industry, setIndustry] = useState<(typeof INDUSTRY_OPTIONS)[number]["value"]>("all");
  const [ownerScope, setOwnerScope] = useState<(typeof OWNER_SCOPE_OPTIONS)[number]["value"]>("all");
  const [page, setPage] = useState(1);

  // Summary-card drill state lives in the URL (?card=) so it is shareable + back-button-safe. The card
  // filter is merged into the server query, so the card count a user clicks === the count of the list it
  // drills to (the aggregates and the filters share one predicate server-side).
  const [searchParams, setSearchParams] = useSearchParams();
  const activeCard = searchParams.get("card");

  const { companies: rawCompanies, pagination, loading, error, refetch } = useCompanies({
    search: search || undefined,
    industry: industry === "all" ? undefined : industry,
    ownerScope: ownerScope === "mine" ? "mine" : undefined,
    hasActivePipeline: activeCard === "pipeline" ? true : undefined,
    stale: activeCard === "stale" ? true : undefined,
    page,
    limit: 50,
  });

  // Reset to page 1 whenever the card drill CHANGES (not on mount), so drilling from a high page never
  // lands on an out-of-range, empty page of the smaller filtered set.
  const prevCardRef = useRef(activeCard);
  useEffect(() => {
    if (prevCardRef.current !== activeCard) {
      prevCardRef.current = activeCard;
      setPage(1);
    }
  }, [activeCard]);

  const buildCardTo = (card: "pipeline" | "stale" | null) => {
    const next = new URLSearchParams(searchParams);
    if (card) next.set("card", card);
    else next.delete("card");
    const qs = next.toString();
    return `/companies${qs ? `?${qs}` : ""}`;
  };
  const clearCard = () => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("card");
      return next;
    });
  };
  // No-blank: keep the prior page of accounts visible during a search/filter/page refetch; gate
  // the skeleton to the FIRST load only and show an "Updating..." hint on a refresh.
  const { data: companies, isInitialLoading, isRefreshing } = useKeepPreviousData(rawCompanies, loading, error);

  const totals = useMemo(() => {
    // Active pipeline ($ sum) and Untouched (count) are now SERVER aggregates over the full filtered set
    // (not the visible page), so the cards reconcile with the lists they drill to. activeDeals stays a
    // page-scoped badge hint.
    const activeDeals = companies.reduce((sum, company) => sum + (company.activeDealsCount ?? company.dealCount ?? 0), 0);
    return {
      pipeline: pagination.pipelineTotal ?? 0,
      stale: pagination.staleCount ?? 0,
      activeDeals,
    };
  }, [pagination.pipelineTotal, pagination.staleCount, companies]);

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
        <MetricCard
          eyebrow="Total accounts"
          value={String(pagination.baseTotal ?? pagination.total)}
          badge={`${companies.length} shown`}
          caption="Directory"
          tone="green"
          accent="red"
          to={buildCardTo(null)}
          ariaLabel="Show all accounts in this view"
          className={!activeCard ? ACTIVE_CARD_CLASS : undefined}
        />
        <MetricCard
          eyebrow="Active pipeline"
          value={USD_COMPACT(totals.pipeline)}
          badge={`${totals.activeDeals} active deals`}
          caption="Open value"
          tone="blue"
          accent="blue"
          to={buildCardTo("pipeline")}
          ariaLabel="Filter to accounts with active pipeline"
          className={activeCard === "pipeline" ? ACTIVE_CARD_CLASS : undefined}
        />
        <MetricCard
          eyebrow="Untouched 30d+"
          value={String(totals.stale)}
          badge="Review"
          caption="Needs touch"
          tone="red"
          accent="red"
          to={buildCardTo("stale")}
          ariaLabel="Filter to accounts untouched 30+ days"
          className={activeCard === "stale" ? ACTIVE_CARD_CLASS : undefined}
        />
      </div>

      {activeCard ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-red/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-red ring-1 ring-brand-red/20">
            Filtered: {COMPANY_CARD_LABELS[activeCard] ?? activeCard}
            <button
              type="button"
              onClick={clearCard}
              aria-label="Clear card filter"
              className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-brand-red/20"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      ) : null}

      <Card className="border-slate-200 bg-white shadow-none">
        <CardContent className="space-y-4 p-4">
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
                value={ownerScope}
                onChange={(value) => {
                  setOwnerScope(value);
                  setPage(1);
                }}
                ariaLabel="Ownership filter"
                size="touch"
              />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
              {isInitialLoading ? "Loading accounts" : `${pagination.total} results${isRefreshing ? " · Updating..." : ""}`}
            </p>
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
                          {formatLastActivity(company.lastActivityAt)}
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
