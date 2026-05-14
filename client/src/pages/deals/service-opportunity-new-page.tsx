import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ServiceOpportunityForm } from "@/components/deals/service-opportunity-form";

export function ServiceOpportunityNewPage() {
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-1"
          onClick={() => navigate("/deals")}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Deals
        </Button>
        <h2 className="text-2xl font-bold">New Service Opportunity</h2>
      </div>
      <ServiceOpportunityForm />
    </div>
  );
}
