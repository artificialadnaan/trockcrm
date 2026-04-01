import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DealForm } from "@/components/deals/deal-form";
import { useDealDetail } from "@/hooks/use-deals";

export function DealEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { deal, loading, error } = useDealDetail(id);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !deal) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Deal not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/deals")}>
          Back to Deals
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-1"
          onClick={() => navigate(`/deals/${id}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Deal
        </Button>
        <h2 className="text-2xl font-bold">Edit Deal</h2>
        <p className="text-sm text-muted-foreground">{deal.dealNumber} - {deal.name}</p>
      </div>
      <DealForm deal={deal} />
    </div>
  );
}
