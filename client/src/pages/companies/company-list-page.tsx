import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Building2, ChevronLeft, ChevronRight, Globe2, Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle } from "@/components/shared/scope-toggle";
import { USD, USD_COMPACT } from "@/components/shared/formatters";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompanies, type Company } from "@/hooks/use-companies";
import { cn } from "@/lib/utils";

const INDUSTRY_LABELS: Record<string, string> = {
  general_contractor: "General contractor",
  construction_manager: "Construction manager",
  property_owner: "Property owner",
  property_management: "Property management",
  reit: "REIT",
  architecture_engineering: "Architecture / engineering",
  consultant: "Consultant",
  insurance_restoration: "Insurance restoration",
  other: "Other",
};

const INDUSTRY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "general_contractor", label: "GC" },
  { value: "property_owner", label: "Owner" },
  { value: "property_management", label: "Mgmt" },
  { value: "insurance_restoration", label: "Restoration" },
] as const;

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

export function CompanyListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [industry, setIndustry] = useState<(typeof INDUSTRY_OPTIONS)[number]["value"]>("all");
  const [page, setPage] = useState(1);

  const { companies, pagination, loading, error } = useCompanies({
    search: search || undefined,
    industry: industry === "all" ? undefined : industry,
    page,
    limit: 50,
  });

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
        <MetricCard eyebrow="Active pipeline" value={USD_COMPACT(totals.pipeline)} badge={`${totals.activeDeals} deals`} caption="Open value" tone="blue" accent="blue" />
        <MetricCard eyebrow="Untouched 30d+" value={String(totals.stale)} badge="Review" caption="Needs touch" tone="red" accent="red" />
      </div>

      <Card className="border-slate-200 bg-white shadow-none">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-[240px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search accounts, cities, domains..."
                  className="h-9 border-slate-200 pl-9"
                />
              </div>
              <ScopeToggle
                options={INDUSTRY_OPTIONS}
                value={industry}
                onChange={(value) => {
                  setIndustry(value);
                  setPage(1);
                }}
                ariaLabel="Industry filter"
              />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
              {loading ? "Loading accounts" : `${pagination.total} results`}
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
          ) : companies.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 px-6 py-14 text-center">
              <Building2 className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-base font-black uppercase text-slate-950">No companies match this view</p>
              <p className="mt-1 text-sm text-slate-500">Clear the search or switch the industry filter.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Company</TableHead>
                  <TableHead className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Industry</TableHead>
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
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">
                          {company.industry ? INDUSTRY_LABELS[company.industry] ?? company.industry : "Unclassified"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-black tabular-nums">{company.propertiesCount ?? 0}</TableCell>
                      <TableCell className="text-right font-black tabular-nums">{company.contactsCount ?? company.contactCount}</TableCell>
                      <TableCell className="text-right">
                        <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-black text-brand-red ring-1 ring-red-100">
                          {company.activeDealsCount ?? company.dealCount}
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
            </Table>
          )}
        </CardContent>
      </Card>

      {pagination.totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-500">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="icon" disabled={pagination.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Previous companies page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((value) => Math.min(pagination.totalPages, value + 1))} aria-label="Next companies page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
