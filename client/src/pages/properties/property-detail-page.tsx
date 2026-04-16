import { useMemo } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Building2, MapPin, Users, Handshake, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import { useDeals } from "@/hooks/use-deals";
import { useProperties } from "@/hooks/use-properties";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { useCompanies } from "@/hooks/use-companies";

function formatPropertyLine(
  address: string | null,
  city: string | null,
  state: string | null,
  zip: string | null
) {
  return [address, [city, state].filter(Boolean).join(", "), zip]
    .filter(Boolean)
    .join(" ");
}

export function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { properties, loading, error } = useProperties();
  const { deals, loading: dealsLoading } = useDeals({
    limit: 2000,
    page: 1,
    isActive: true,
    sortBy: "updated_at",
    sortDir: "desc",
  });
  const { stages } = usePipelineStages();
  const { companies } = useCompanies({ limit: 2000, page: 1 });

  const ddStageId = stages.find((stage) => stage.slug === "dd")?.id ?? "";
  const companyMap = useMemo(
    () => new Map(companies.map((company) => [company.id, company.name])),
    [companies]
  );

  const property = useMemo(
    () => properties.find((item) => item.id === id) ?? null,
    [id, properties]
  );

  const relatedDeals = useMemo(() => {
    if (!property) return [];
    return deals.filter((deal) => property.dealIds.includes(deal.id));
  }, [deals, property]);

  const leadDeals = relatedDeals.filter((deal) => deal.stageId === ddStageId);
  const activeDeals = relatedDeals.filter((deal) => deal.stageId !== ddStageId);

  if (loading || dealsLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 rounded bg-muted animate-pulse" />
        <div className="h-40 rounded-lg bg-muted animate-pulse" />
        <div className="h-72 rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  if (error || !property) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Property not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/properties")}>
          Back to Properties
        </Button>
      </div>
    );
  }

  const companyName = property.companyName ?? (property.companyId ? companyMap.get(property.companyId) ?? null : null);
  const propertyLine = formatPropertyLine(property.address, property.city, property.state, property.zip);

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground hover:text-foreground"
        onClick={() => navigate("/properties")}
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Properties
      </Button>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Building2 className="h-4 w-4 text-brand-red" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-brand-red">
            Property Detail
          </span>
        </div>
        <h1 className="text-4xl font-black tracking-tight text-foreground">{property.label}</h1>
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="h-4 w-4" />
            {companyName ?? "Unassigned company"}
          </span>
          {propertyLine && (
            <span className="flex items-center gap-1">
              <MapPin className="h-4 w-4" />
              {propertyLine}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock3 className="h-4 w-4" />
            {property.lastActivityAt ? "Recently active" : "No activity yet"}
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Leads</p>
            <p className="mt-2 text-2xl font-black">{property.leadCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Deals</p>
            <p className="mt-2 text-2xl font-black">{property.dealCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Converted</p>
            <p className="mt-2 text-2xl font-black">{activeDeals.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Last Activity</p>
            <p className="mt-2 text-sm font-semibold">
              {property.lastActivityAt
                ? new Date(property.lastActivityAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "--"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Related Leads</p>
                  <p className="text-sm text-muted-foreground">Pre-RFP opportunities at this property.</p>
                </div>
                <span className="text-xs text-muted-foreground">{leadDeals.length} items</span>
              </div>
              <div className="mt-4 space-y-2">
                {leadDeals.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No leads at this property yet.
                  </div>
                ) : (
                  leadDeals.map((deal) => (
                    <Link
                      key={deal.id}
                      to={`/leads/${deal.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{deal.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{deal.dealNumber}</p>
                      </div>
                      <LeadStageBadge stageId={deal.stageId} />
                    </Link>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Related Deals</p>
                  <p className="text-sm text-muted-foreground">All active opportunities tied to this property.</p>
                </div>
                <span className="text-xs text-muted-foreground">{relatedDeals.length} items</span>
              </div>
              <div className="mt-4 space-y-2">
                {relatedDeals.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No related deals found.
                  </div>
                ) : (
                  relatedDeals.map((deal) => (
                    <Link
                      key={deal.id}
                      to={`/deals/${deal.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{deal.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{deal.dealNumber}</p>
                      </div>
                      <DealStageBadge stageId={deal.stageId} />
                    </Link>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm font-medium">Activity Rollup</p>
              <p className="text-sm text-muted-foreground">
                This property aggregates activity across every deal tied to the address.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-muted-foreground">Lead Activity</p>
                  <p className="text-xl font-black">{property.leadCount}</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-muted-foreground">Total Deals</p>
                  <p className="text-xl font-black">{property.dealCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <p className="text-sm font-medium">Current Company</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {companyName ?? "No company attached to this property."}
              </p>
              {property.companyId && (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => navigate(`/companies/${property.companyId}`)}
                >
                  Open Company
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
