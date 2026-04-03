import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronRight, ChevronLeft, MapPin, Wrench } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompanies } from "@/hooks/use-companies";

const COMPANY_CATEGORY_LABELS: Record<string, string> = {
  client: "Client",
  subcontractor: "Subcontractor",
  architect: "Architect",
  property_manager: "Property Manager",
  vendor: "Vendor",
  consultant: "Consultant",
  other: "Other",
};

export function CompanyListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);

  const { companies, pagination, loading, error } = useCompanies({
    search: search || undefined,
    category: category || undefined,
    page,
    limit: 50,
  });

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleCategory = (value: string) => {
    setCategory(value === "all" ? "" : value);
    setPage(1);
  };

  // Footer stats computed from current data
  const tierOneCount = companies.filter((c) => c.category === "client").length;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const newVendorCount = companies.filter(
    (c) => new Date(c.createdAt).getTime() >= thirtyDaysAgo
  ).length;
  const totalDeals = companies.reduce((sum, c) => sum + c.dealCount, 0);

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-6 py-8">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Building2 className="h-3.5 w-3.5 text-brand-red" />
              <span className="text-[10px] font-bold tracking-widest uppercase text-brand-red">
                Directory
              </span>
            </div>
            <h1 className="text-5xl font-black tracking-tighter uppercase text-gray-900 leading-none">
              Companies
            </h1>
            <p className="mt-3 text-sm text-gray-500 max-w-md">
              Manage your network of partner firms, trusted subcontractors, and material vendors.
            </p>
          </div>
          <button
            onClick={() => navigate("/companies/new")}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white rounded-md"
            style={{ background: "linear-gradient(135deg, #CC0000 0%, #990000 100%)" }}
          >
            <Building2 className="h-4 w-4" />
            Add Company
          </button>
        </div>
      </div>

      {/* Filters Row */}
      <div className="border-b border-gray-200 bg-gray-50 px-6 py-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              placeholder="Search companies..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="h-7 text-xs w-48 border-gray-300 bg-white"
            />
            <Select value={category || "all"} onValueChange={(v) => handleCategory(v ?? "all")}>
              <SelectTrigger className="h-7 text-xs w-40 border-gray-300 bg-white">
                <SelectValue placeholder="Industry: All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Industry: All</SelectItem>
                {Object.entries(COMPANY_CATEGORY_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!loading && (
            <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">
              Showing {pagination.total} result{pagination.total !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="mx-6 mt-4 p-4 bg-red-50 text-red-700 rounded-lg text-sm border border-red-200">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="divide-y divide-gray-100">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={`flex items-center gap-4 px-6 py-5 ${i % 2 === 1 ? "bg-gray-50" : "bg-white"}`}>
              <div className="w-1 self-stretch bg-gray-200 rounded" />
              <div className="h-10 w-10 bg-gray-200 animate-pulse rounded" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-gray-200 animate-pulse rounded w-48" />
                <div className="h-3 bg-gray-100 animate-pulse rounded w-32" />
              </div>
              <div className="flex gap-8">
                <div className="h-8 w-16 bg-gray-100 animate-pulse rounded" />
                <div className="h-8 w-16 bg-gray-100 animate-pulse rounded" />
                <div className="h-8 w-20 bg-gray-100 animate-pulse rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && companies.length === 0 && (
        <div className="text-center py-24">
          <div className="inline-flex items-center justify-center h-16 w-16 bg-gray-100 rounded mb-4">
            <Building2 className="h-8 w-8 text-gray-400" />
          </div>
          <p className="text-lg font-bold uppercase tracking-tight text-gray-900">No companies found</p>
          <p className="text-sm text-gray-500 mt-1">Try adjusting your filters or create a new company.</p>
        </div>
      )}

      {/* Company List */}
      {!loading && companies.length > 0 && (
        <div className="divide-y divide-gray-100">
          {companies.map((company, idx) => {
            const isClient = company.category === "client";
            const categoryLabel = company.category
              ? COMPANY_CATEGORY_LABELS[company.category] ?? company.category
              : null;
            const location = [company.city, company.state].filter(Boolean).join(", ");

            return (
              <div
                key={company.id}
                onClick={() => navigate(`/companies/${company.id}`)}
                className={`flex items-center gap-4 px-6 py-5 cursor-pointer transition-colors group ${
                  idx % 2 === 1 ? "bg-gray-50 hover:bg-gray-100" : "bg-white hover:bg-gray-50"
                }`}
              >
                {/* Left border accent */}
                <div
                  className={`w-1 self-stretch rounded ${
                    isClient ? "bg-brand-red" : "bg-gray-300"
                  }`}
                />

                {/* Icon box */}
                <div className="h-10 w-10 flex-shrink-0 bg-gray-100 flex items-center justify-center">
                  <Building2 className="h-5 w-5 text-gray-500" />
                </div>

                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-bold tracking-tight uppercase text-gray-900 truncate">
                      {company.name}
                    </h3>
                    {/* Active dot — show for clients */}
                    {isClient && (
                      <span className="flex-shrink-0 h-2 w-2 rounded-full bg-brand-red" />
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {categoryLabel && (
                      <span className="flex items-center gap-1 text-[11px] text-gray-500">
                        <Wrench className="h-3 w-3" />
                        {categoryLabel}
                      </span>
                    )}
                    {location && (
                      <span className="flex items-center gap-1 text-[11px] text-gray-500">
                        <MapPin className="h-3 w-3" />
                        {location}
                      </span>
                    )}
                  </div>
                </div>

                {/* Stats grid */}
                <div className="hidden sm:flex items-center gap-8 flex-shrink-0">
                  <div className="text-center">
                    <div className="text-xl font-black tracking-tighter text-gray-900">
                      {company.contactCount}
                    </div>
                    <div className="text-[9px] uppercase tracking-widest text-gray-400 font-medium">
                      Contacts
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-black tracking-tighter text-gray-900">
                      {company.dealCount}
                    </div>
                    <div className="text-[9px] uppercase tracking-widest text-gray-400 font-medium">
                      Active Deals
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-black tracking-tighter text-brand-red">
                      —
                    </div>
                    <div className="text-[9px] uppercase tracking-widest text-gray-400 font-medium">
                      Revenue
                    </div>
                  </div>
                </div>

                {/* Chevron */}
                <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0 group-hover:text-brand-red transition-colors" />
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-white">
          <p className="text-xs text-gray-500 uppercase tracking-wider">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              disabled={pagination.page <= 1}
              onClick={() => setPage(pagination.page - 1)}
              className="h-7 w-7 flex items-center justify-center border border-gray-200 rounded text-gray-500 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage(pagination.page + 1)}
              className="h-7 w-7 flex items-center justify-center border border-gray-200 rounded text-gray-500 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Statistics Footer */}
      {!loading && (
        <div className="border-t-2 border-gray-900 bg-white">
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-gray-200">
            <div className="px-6 py-6">
              <div className="text-3xl font-black tracking-tighter text-gray-900">
                {pagination.total}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mt-1">
                Total Network Entities
              </div>
            </div>
            <div className="px-6 py-6">
              <div className="text-3xl font-black tracking-tighter text-brand-red">
                {tierOneCount}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mt-1">
                Tier 1 Subcontractors
              </div>
            </div>
            <div className="px-6 py-6">
              <div className="text-3xl font-black tracking-tighter text-gray-900">
                {newVendorCount}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mt-1">
                New Vendors (Last 30d)
              </div>
            </div>
            <div className="px-6 py-6">
              <div className="text-3xl font-black tracking-tighter text-brand-red">
                {totalDeals}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mt-1">
                Active Contract Value
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
