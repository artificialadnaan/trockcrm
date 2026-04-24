import { useNavigate } from "react-router-dom";
import { Handshake, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import type { Contact } from "@/hooks/use-contacts";
import { useContactDeals, removeContactDealAssociation } from "@/hooks/use-contacts";

interface ContactDealsTabProps {
  contactId: string;
  contact: Pick<Contact, "id" | "firstName" | "lastName" | "companyId" | "companyName" | "jobTitle">;
}

export function ContactDealsTab({ contactId, contact }: ContactDealsTabProps) {
  const navigate = useNavigate();
  const { associations, loading, error, refetch } = useContactDeals(contactId);

  const handleRemove = async (associationId: string) => {
    if (!window.confirm("Remove this deal association?")) return;
    try {
      await removeContactDealAssociation(associationId);
      refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to remove association");
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>;
  }

  if (associations.length === 0) {
    const params = new URLSearchParams();
    if (contact.companyId) {
      params.set("companyId", contact.companyId);
    }
    params.set("primaryContactId", contact.id);
    params.set("name", contact.companyName ? `${contact.companyName} opportunity` : `${contact.firstName} ${contact.lastName} opportunity`);
    params.set("source", "Contact relationship");
    params.set(
      "description",
      [contact.jobTitle, contact.companyName].filter(Boolean).join(" · ") || "Deal seeded from contact record"
    );

    return (
      <div className="text-center py-8 text-muted-foreground">
        <Handshake className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p>No deals associated with this contact.</p>
        <Button className="mt-4" onClick={() => navigate(`/deals/new?${params.toString()}`)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Deal
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {associations.map((assoc) => (
        <Card key={assoc.id} className="p-3">
          <div className="flex items-center justify-between gap-3">
            <div
              className="flex-1 min-w-0 cursor-pointer"
              onClick={() => navigate(`/deals/${assoc.deal.id}`)}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-mono">
                  {assoc.deal.dealNumber}
                </span>
                <DealStageBadge stageId={assoc.deal.stageId} />
                {assoc.isPrimary && (
                  <Badge variant="outline" className="text-xs">Primary</Badge>
                )}
              </div>
              <p className="font-medium truncate">{assoc.deal.name}</p>
              {assoc.role && (
                <p className="text-xs text-muted-foreground">Role: {assoc.role}</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-red-600 shrink-0"
              onClick={() => handleRemove(assoc.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
