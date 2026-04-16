import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Building2, MapPin, Clock3, User, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LeadForm } from "@/components/leads/lead-form";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { useDealDetail } from "@/hooks/use-deals";
import { useCompanyDetail } from "@/hooks/use-companies";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

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

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { deal, loading, error } = useDealDetail(id);
  const { company } = useCompanyDetail(deal?.companyId ?? undefined);
  const { stages } = usePipelineStages();

  const currentStage = useMemo(
    () => stages.find((stage) => stage.id === deal?.stageId) ?? null,
    [deal?.stageId, stages]
  );
  const isLeadStage = currentStage?.slug === "dd";
  const convertedAt = isLeadStage ? null : deal?.stageEnteredAt ?? null;

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-44 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error || !deal) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Lead not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/leads")}>
          Back to Leads
        </Button>
      </div>
    );
  }

  const leadCompanyName = company?.name ?? null;
  const propertyLine = formatPropertyLine(
    deal.propertyAddress,
    deal.propertyCity,
    deal.propertyState,
    deal.propertyZip
  );

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground hover:text-foreground"
        onClick={() => navigate("/leads")}
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Leads
      </Button>

      <div className="grid gap-6 lg:grid-cols-[1.35fr_0.9fr]">
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-mono uppercase tracking-[0.18em] text-muted-foreground">
                {deal.dealNumber}
              </span>
              <LeadStageBadge stageId={deal.stageId} converted={!isLeadStage} />
            </div>
            <h1 className="text-4xl font-black tracking-tight text-foreground">{deal.name}</h1>
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Building2 className="h-4 w-4" />
                {leadCompanyName ?? "Unassigned company"}
              </span>
              {propertyLine && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {propertyLine}
                </span>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Stage</p>
                <p className="mt-2 text-sm font-semibold">{currentStage?.name ?? "Lead"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Activity</p>
                <p className="mt-2 text-sm font-semibold">Inherited into deal timeline</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
                <p className="mt-2 text-sm font-semibold">
                  {new Date(deal.updatedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </CardContent>
            </Card>
          </div>

          <LeadTimelineTab dealId={deal.id} convertedAt={convertedAt} />
        </div>

        <div className="space-y-4">
          <LeadForm
          lead={{
            id: deal.id,
            name: deal.name,
            dealNumber: deal.dealNumber,
            companyId: deal.companyId ?? null,
            companyName: leadCompanyName,
            stageId: deal.stageId,
            propertyAddress: deal.propertyAddress,
              propertyCity: deal.propertyCity,
              propertyState: deal.propertyState,
              propertyZip: deal.propertyZip,
              source: deal.source,
              description: deal.description,
              stageEnteredAt: deal.stageEnteredAt,
            }}
            converted={!isLeadStage}
          />

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Lead context</p>
              </div>
              <p className="text-sm text-muted-foreground">
                {isLeadStage
                  ? "This record is still in the lead stage. Converting it moves the work into the deal pipeline."
                  : "This lead has already been converted, but the pre-RFP history remains available here."}
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" />
                <span>{deal.primaryContactId ? "Primary contact linked" : "No primary contact yet"}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Phone className="h-4 w-4" />
                <span>{deal.lastActivityAt ? "Activity recorded" : "No activity yet"}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
