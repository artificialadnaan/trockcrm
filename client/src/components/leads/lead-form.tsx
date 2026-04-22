import { Link } from "react-router-dom";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LeadStageBadge } from "./lead-stage-badge";
import { convertLead } from "@/hooks/use-leads";

export interface LeadFormLead {
  id: string;
  name: string;
  convertedDealId: string | null;
  convertedDealNumber: string | null;
  companyId: string | null;
  companyName: string | null;
  stageId: string;
  propertyId: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  source: string | null;
  description: string | null;
  stageEnteredAt: string;
}

interface LeadFormProps {
  lead: LeadFormLead;
  converted?: boolean;
  defaultDealStageId?: string | null;
  showPrimaryAction?: boolean;
}

export function LeadForm({
  lead,
  converted = false,
  defaultDealStageId = null,
  showPrimaryAction = true,
}: LeadFormProps) {
  const navigate = useNavigate();
  const [converting, setConverting] = useState(false);
  const propertyLabel =
    [
      lead.propertyAddress,
      [lead.propertyCity, lead.propertyState].filter(Boolean).join(", "),
      lead.propertyZip,
    ]
      .filter(Boolean)
      .join(" ") || lead.propertyName || "--";

  const handlePrimaryAction = async () => {
    if (converted) {
      if (lead.convertedDealId) {
        navigate(`/deals/${lead.convertedDealId}`);
      }
      return;
    }

    if (!defaultDealStageId) {
      navigate("/deals/new");
      return;
    }

    setConverting(true);
    try {
      const result = await convertLead(lead.id, {
        dealStageId: defaultDealStageId,
        name: lead.name,
        source: lead.source,
        description: lead.description,
      });
      toast.success("Lead converted to deal");
      navigate(`/deals/${result.deal.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to convert lead");
    } finally {
      setConverting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Lead Summary</CardTitle>
          <LeadStageBadge stageId={lead.stageId} converted={converted} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">Lead Name</p>
            <p className="font-medium">{lead.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Lead Record</p>
            <p className="font-mono font-medium">{lead.convertedDealNumber ?? lead.id.slice(0, 8)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Company</p>
            <p className="font-medium">{lead.companyName ?? "Unassigned"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Source</p>
            <p className="font-medium">{lead.source ?? "--"}</p>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="text-muted-foreground">Property</p>
          {lead.propertyId ? (
            <Link to={`/properties/${lead.propertyId}`} className="font-medium text-primary hover:underline">
              {propertyLabel}
            </Link>
          ) : (
            <p className="font-medium">{propertyLabel}</p>
          )}
        </div>

        {lead.description && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.description}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {showPrimaryAction && (
            <Button
              disabled={converting || (converted && !lead.convertedDealId)}
              onClick={handlePrimaryAction}
            >
              {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {converted ? "Open Deal" : "Convert to Deal"}
            </Button>
          )}
          {lead.companyId && (
            <Button variant="outline" onClick={() => navigate(`/companies/${lead.companyId}`)}>
              View Company
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          This lead surface is backed by the pre-RFP lead record and preserves its activity history through conversion.
        </p>
      </CardContent>
    </Card>
  );
}
