import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LeadForm } from "@/components/leads/lead-form";

export function LeadNewPage() {
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => navigate("/leads")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Leads
        </Button>
        <h2 className="text-2xl font-bold">New Lead</h2>
      </div>
      <LeadForm mode="create" />
    </div>
  );
}
