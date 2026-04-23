import { useState } from "react";
import { ArrowRightLeft, Building2, Loader2, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  applyOpportunityRoutingReview,
  updateDeal,
  type DealDepartment,
} from "@/hooks/use-deals";

const DEPARTMENT_LABELS: Record<DealDepartment, string> = {
  sales: "Sales",
  estimating: "Estimating",
  client_services: "Client Services",
  operations: "Operations",
};

function formatDispositionLabel(value: "opportunity" | "deals" | "service") {
  return value === "opportunity" ? "Opportunity" : value === "deals" ? "Deals" : "Service";
}

export function OpportunityRoutingPanel({
  deal,
  currentStageSlug,
  onUpdated,
}: {
  deal: {
    id: string;
    stageId: string;
    pipelineDisposition: "opportunity" | "deals" | "service";
    workflowRoute: "normal" | "service" | null;
    ddEstimate: string | null;
    bidEstimate: string | null;
    departmentOwnership: {
      currentDepartment: DealDepartment;
      acceptanceStatus: "pending" | "accepted";
      effectiveOwnerUserId: string | null;
      pendingDepartment: DealDepartment | null;
    };
    routingHistory: Array<{
      id: string;
      fromWorkflowRoute: "normal" | "service" | null;
      toWorkflowRoute: "normal" | "service";
      valueSource: string;
      triggeringValue: string;
      reason: string | null;
      createdAt: string;
    }>;
  };
  currentStageSlug: string;
  onUpdated: () => void;
}) {
  const [earlyAmount, setEarlyAmount] = useState(deal.ddEstimate ?? "");
  const [postBidAmount, setPostBidAmount] = useState(deal.bidEstimate ?? "");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState<"early" | "post_bid" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReview = currentStageSlug === "opportunity";

  const handleReview = async (
    reviewType: "early" | "post_bid",
    amount: string,
    valueSource: "sales_estimated_opportunity_value" | "procore_bidboard_estimate"
  ) => {
    if (!amount.trim()) {
      setError("Enter an amount before applying routing review.");
      return;
    }

    setSubmitting(reviewType);
    setError(null);
    try {
      await updateDeal(deal.id, reviewType === "early" ? { ddEstimate: amount } : { bidEstimate: amount });
      await applyOpportunityRoutingReview(deal.id, {
        valueSource,
        amount,
        reason: reason.trim() || undefined,
      });
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Routing review failed");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2">
            <Route className="h-4 w-4 text-muted-foreground" />
            Routing and Ownership
          </CardTitle>
          <Badge variant="outline">{formatDispositionLabel(deal.pipelineDisposition)}</Badge>
          <Badge variant="outline">{deal.workflowRoute === "service" ? "Service Route" : deal.workflowRoute === "normal" ? "Deals Route" : "Route Pending"}</Badge>
        </div>
        <CardDescription>
          Sales keeps visibility here even after estimating, service, or operations ownership changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Accountable Department
            </div>
            <div className="mt-1 text-sm font-medium">
              {DEPARTMENT_LABELS[deal.departmentOwnership.currentDepartment]}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Handoff status: {deal.departmentOwnership.acceptanceStatus}
              {deal.departmentOwnership.pendingDepartment
                ? ` to ${DEPARTMENT_LABELS[deal.departmentOwnership.pendingDepartment]}`
                : ""}
            </div>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Recent Route Changes
            </div>
            {deal.routingHistory.length === 0 ? (
              <div className="mt-1 text-sm text-muted-foreground">No routing reviews applied yet.</div>
            ) : (
              <div className="mt-1 space-y-1 text-sm">
                {deal.routingHistory.slice(0, 2).map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2">
                    <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>
                      {(entry.fromWorkflowRoute ?? "opportunity").replace("_", " ")} to {entry.toWorkflowRoute}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {canReview && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border p-4">
              <div className="mb-3 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <div className="font-medium">Early Routing Review</div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="early-routing-amount">Sales Estimated Opportunity Value</Label>
                <Input
                  id="early-routing-amount"
                  value={earlyAmount}
                  onChange={(event) => setEarlyAmount(event.target.value)}
                  placeholder="45000"
                />
              </div>
              <Button
                className="mt-3 w-full"
                disabled={submitting !== null}
                onClick={() =>
                  void handleReview("early", earlyAmount, "sales_estimated_opportunity_value")
                }
              >
                {submitting === "early" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Apply Early Review
              </Button>
            </div>

            <div className="rounded-lg border p-4">
              <div className="mb-3 flex items-center gap-2">
                <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
                <div className="font-medium">Post-Bid Routing Review</div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="post-bid-routing-amount">Bid Board / Procore Estimate</Label>
                <Input
                  id="post-bid-routing-amount"
                  value={postBidAmount}
                  onChange={(event) => setPostBidAmount(event.target.value)}
                  placeholder="62000"
                />
              </div>
              <Button
                className="mt-3 w-full"
                disabled={submitting !== null}
                onClick={() =>
                  void handleReview("post_bid", postBidAmount, "procore_bidboard_estimate")
                }
              >
                {submitting === "post_bid" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Apply Post-Bid Review
              </Button>
            </div>
          </div>
        )}

        {canReview && (
          <div className="space-y-2">
            <Label htmlFor="routing-review-reason">Routing Review Notes</Label>
            <Textarea
              id="routing-review-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Capture threshold changes, client direction, or estimate context."
            />
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}
