import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button";
import { ServiceOpportunityForm } from "@/components/deals/service-opportunity-form";
import { cn } from "@/lib/utils";

export function ServiceOpportunityNewPage() {
  const [searchParams] = useSearchParams();
  // Same prefill convention as /leads/new (propertyId + companyId + name), so the property page can hand the
  // rep a form with the property ALREADY chosen. That is the point of the feature: an address that is never
  // retyped is an address that never becomes a second property record.
  const initialValues = useMemo(
    () => ({
      companyId: searchParams.get("companyId") ?? "",
      propertyId: searchParams.get("propertyId") ?? "",
      name: searchParams.get("name") ?? "",
    }),
    [searchParams]
  );

  // Where Back goes, from an EXPLICIT param — never history.back(), which has nowhere to go on a fresh tab, a
  // hard refresh or a shared link. It carries an id rather than a path so it can never be pointed off-site.
  const returnPropertyId = searchParams.get("returnPropertyId")?.trim() ?? "";
  // Office context is URL-driven platform-wide (lib/api reads ?officeId and sends it as x-office-id), so it
  // has to survive the hop back as well — silently dropping it here is how cross-office context gets lost.
  const officeId = searchParams.get("officeId")?.trim() ?? "";
  const officeQuery = officeId ? `?officeId=${encodeURIComponent(officeId)}` : "";
  const backTo = returnPropertyId
    ? `/properties/${encodeURIComponent(returnPropertyId)}${officeQuery}`
    : `/deals${officeQuery}`;
  const backLabel = returnPropertyId ? "Property" : "Deals";

  return (
    <div className="space-y-4">
      <div>
        {/* An anchor, not a history pop: the destination is the same whether the rep clicked through from a
            property or opened the link cold, and middle-click / open-in-new-tab keep working. */}
        <Link to={backTo} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2 mb-1")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          {backLabel}
        </Link>
        <h2 className="text-2xl font-bold">New Service Opportunity</h2>
      </div>
      {/* The office goes to the form as well, not just onto the back link: a prefilled property lives in one
          office's schema, and lib/api's URL fallback is overridden the moment the form sends its own
          x-office-id. Without this a rep whose home office differs resolves the property in the wrong tenant
          and creates the deal there too. Empty (deals-page entry) leaves the home-office behaviour alone. */}
      <ServiceOpportunityForm initialValues={initialValues} officeId={officeId || null} />
    </div>
  );
}
