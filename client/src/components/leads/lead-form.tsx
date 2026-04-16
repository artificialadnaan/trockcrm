import { Link } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LeadStageBadge } from "./lead-stage-badge";

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
}

export function LeadForm({ lead, converted = false }: LeadFormProps) {
  const navigate = useNavigate();
  const propertyLabel = [lead.propertyAddress, [lead.propertyCity, lead.propertyState].filter(Boolean).join(", "), lead.propertyZip]
    .filter(Boolean)
    .join(" ") || lead.propertyName || "--";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Lead Summary</CardTitle>
          <LeadStageBadge stageId={lead.stageId} converted={converted} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
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
              {propertyLabel || "--"}
            </Link>
          ) : (
            <p className="font-medium">{propertyLabel || "--"}</p>
          )}
        </div>

        {lead.description && (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{lead.description}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={converted && !lead.convertedDealId}
            onClick={() => navigate(converted ? `/deals/${lead.convertedDealId}` : "/deals/new")}
          >
            {converted ? "Open Deal" : "Convert to Deal"}
          </Button>
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
