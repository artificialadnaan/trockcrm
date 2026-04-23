import { ArrowLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LeadForm } from "@/components/leads/lead-form";
import { formatLeadPropertyLine, useLeadDetail } from "@/hooks/use-leads";

export function LeadEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { lead, loading, error } = useLeadDetail(id);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="h-96 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error || !lead) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Lead not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/leads")}>
          Back to Leads
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => navigate(`/leads/${lead.id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Lead Details
        </Button>
        <h2 className="text-2xl font-bold">Edit Lead Qualification</h2>
        <p className="text-sm text-muted-foreground">
          {lead.companyName ?? "Unassigned company"}
          {formatLeadPropertyLine(lead) ? ` • ${formatLeadPropertyLine(lead)}` : ""}
        </p>
      </div>
      <LeadForm
        mode="edit"
        onSaved={() => navigate(`/leads/${lead.id}`)}
        lead={{
          id: lead.id,
          name: lead.name,
          convertedDealId: lead.convertedDealId,
          convertedDealNumber: lead.convertedDealNumber,
          companyId: lead.companyId ?? null,
          companyName: lead.companyName,
          stageId: lead.stageId,
          propertyId: lead.propertyId,
          propertyName: lead.property?.name ?? null,
          propertyAddress: lead.property?.address ?? null,
          propertyCity: lead.property?.city ?? null,
          propertyState: lead.property?.state ?? null,
          propertyZip: lead.property?.zip ?? null,
          source: lead.source,
          description: lead.description,
          projectTypeId: lead.projectTypeId,
          projectType: lead.projectType,
          qualificationPayload: lead.qualificationPayload,
          projectTypeQuestionPayload: lead.projectTypeQuestionPayload,
          stageEnteredAt: lead.stageEnteredAt,
        }}
      />
    </div>
  );
}
