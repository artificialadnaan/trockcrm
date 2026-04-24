import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DealForm } from "@/components/deals/deal-form";

export function DealNewPage() {
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
    }),
    [searchParams]
  );

  return (
    <div className="space-y-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-1"
          onClick={() => navigate("/deals")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Deals
        </Button>
        <h2 className="text-2xl font-bold">New Deal</h2>
      </div>
      <DealForm initialValues={initialValues} />
    </div>
  );
}
