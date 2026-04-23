import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { LeadForm } from "@/components/leads/lead-form";

export function LeadNewPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialValues = useMemo(
    () => ({
      companyId: searchParams.get("companyId") ?? "",
      propertyId: searchParams.get("propertyId") ?? "",
      primaryContactId: searchParams.get("primaryContactId") ?? "",
      name: searchParams.get("name") ?? "",
      source: searchParams.get("source") ?? "",
      description: searchParams.get("description") ?? "",
      projectTypeId: searchParams.get("projectTypeId") ?? "",
      stageId: searchParams.get("stageId") ?? "",
    }),
    [searchParams]
  );

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => navigate("/leads")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Leads
        </Button>
        <h2 className="text-2xl font-bold">New Lead</h2>
      </div>
      <LeadForm mode="create" initialValues={initialValues} />
    </div>
  );
}
