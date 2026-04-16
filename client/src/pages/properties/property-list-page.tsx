import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronLeft, ChevronRight, MapPin, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useProperties } from "@/hooks/use-properties";

export function PropertyListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const { properties, loading, error } = useProperties({ search });

  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(properties.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = properties.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const totals = useMemo(() => ({
    properties: properties.length,
    leads: properties.reduce((sum, property) => sum + property.leadCount, 0),
    deals: properties.reduce((sum, property) => sum + property.dealCount, 0),
  }), [properties]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Building2 className="h-4 w-4 text-brand-red" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand-red">
              Property Surface
            </span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">Properties</h1>
          <p className="text-sm text-muted-foreground">
            {totals.properties} property{totals.properties !== 1 ? "s" : ""} across {totals.deals} deals
          </p>
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Search properties or companies..."
          className="pl-9"
        />
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : pageItems.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
          <MapPin className="mx-auto mb-3 h-10 w-10 opacity-30" />
          <p className="text-lg font-medium">No properties found</p>
          <p className="text-sm mt-1">Try a different search or create a deal with a property address.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {pageItems.map((property) => (
            <Card
              key={property.id}
              className="cursor-pointer p-4 transition-colors hover:bg-muted/40"
              onClick={() => navigate(`/properties/${property.id}`)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{property.label}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                    <span>{property.companyName ?? "Unassigned company"}</span>
                    <span>{property.dealCount} deals</span>
                    <span>{property.leadCount} leads</span>
                    {property.lastActivityAt && (
                      <span>Updated {new Date(property.lastActivityAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
