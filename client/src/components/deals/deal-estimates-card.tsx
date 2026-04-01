import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, currentContractValue } from "@/lib/deal-utils";
import type { Deal } from "@/hooks/use-deals";

interface DealEstimatesCardProps {
  deal: Deal;
}

export function DealEstimatesCard({ deal }: DealEstimatesCardProps) {
  const ccv = currentContractValue(deal);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">Estimates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">DD Estimate</span>
          <span className="text-sm font-medium">{formatCurrency(deal.ddEstimate)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Bid Estimate</span>
          <span className="text-sm font-medium">{formatCurrency(deal.bidEstimate)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Awarded Amount</span>
          <span className="text-sm font-semibold">{formatCurrency(deal.awardedAmount)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Change Orders</span>
          <span className="text-sm font-medium">{formatCurrency(deal.changeOrderTotal)}</span>
        </div>
        <div className="border-t pt-2 flex justify-between items-center">
          <span className="text-sm font-medium">Current Contract Value</span>
          <span className="text-base font-bold text-green-600">{formatCurrency(ccv)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
