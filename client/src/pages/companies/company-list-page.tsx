import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, ChevronLeft, ChevronRight, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

const COMPANY_CATEGORY_COLORS: Record<string, string> = {
  client: "bg-blue-100 text-blue-800",
  subcontractor: "bg-orange-100 text-orange-800",
  architect: "bg-red-100 text-red-800",
  property_manager: "bg-green-100 text-green-800",
  vendor: "bg-yellow-100 text-yellow-800",
  consultant: "bg-indigo-100 text-indigo-800",
  other: "bg-gray-100 text-gray-800",
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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Companies</h2>
          <p className="text-sm text-muted-foreground">
            {pagination.total} compan{pagination.total !== 1 ? "ies" : "y"}
          </p>
        </div>
        <Button onClick={() => navigate("/companies/new")}>
          <Plus className="h-4 w-4 mr-2" />
          New Company
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <Input
          placeholder="Search companies..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={category || "all"} onValueChange={(v) => handleCategory(v ?? "all")}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {Object.entries(COMPANY_CATEGORY_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Error State */}
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && companies.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Building2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No companies found</p>
          <p className="text-sm">Try adjusting your filters or create a new company.</p>
        </div>
      )}

      {/* Company List */}
      {!loading && companies.length > 0 && (
        <div className="space-y-2">
          {companies.map((company) => {
            const colorClass =
              company.category
                ? COMPANY_CATEGORY_COLORS[company.category] ?? "bg-gray-100 text-gray-800"
                : "bg-gray-100 text-gray-800";
            const categoryLabel =
              company.category
                ? COMPANY_CATEGORY_LABELS[company.category] ?? company.category
                : null;

            return (
              <Card
                key={company.id}
                className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => navigate(`/companies/${company.id}`)}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="flex-shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-full bg-red-50 text-red-600">
                      <Building2 className="h-4 w-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {categoryLabel && (
                          <Badge variant="outline" className={`${colorClass} border-0 text-xs`}>
                            {categoryLabel}
                          </Badge>
                        )}
                      </div>
                      <h3 className="font-semibold truncate">{company.name}</h3>
                      {(company.city || company.state) && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {[company.city, company.state].filter(Boolean).join(", ")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {company.contactCount} contact{company.contactCount !== 1 ? "s" : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {company.dealCount} deal{company.dealCount !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setPage(pagination.page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage(pagination.page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
