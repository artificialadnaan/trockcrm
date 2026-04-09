import { useState } from "react";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { DealDetail } from "@/hooks/use-deals";
import { PROPOSAL_STATUS_COLORS } from "@/lib/status-colors";
import { formatShortDate } from "@/lib/deal-utils";

interface DealProposalCardProps {
  deal: DealDetail;
  onUpdate: () => void;
}

type ProposalStatus =
  | "not_started"
  | "drafting"
  | "sent"
  | "under_review"
  | "revision_requested"
  | "accepted"
  | "signed"
  | "rejected";

const STATUS_LABELS: Record<ProposalStatus, string> = {
  not_started: "Not Started",
  drafting: "Drafting",
  sent: "Sent",
  under_review: "Under Review",
  revision_requested: "Revision Requested",
  accepted: "Accepted",
  signed: "Signed",
  rejected: "Rejected",
};

const HELPER_TEXT: Record<ProposalStatus, string> = {
  not_started: "Draft your proposal and mark it as sent when ready.",
  drafting: "Finalize the proposal, then mark it as sent to the client.",
  sent: "Waiting for client acknowledgment.",
  under_review: "Client is reviewing. Follow up if no response.",
  revision_requested: "Address client feedback and re-send.",
  accepted: "Client accepted. Get the signature to finalize.",
  signed: "Proposal signed and executed.",
  rejected: "Proposal was not accepted.",
};

export function DealProposalCard({ deal, onUpdate }: DealProposalCardProps) {
  const [loading, setLoading] = useState(false);

  const status = (deal.proposalStatus ?? "not_started") as ProposalStatus;

  const updateStatus = async (newStatus: ProposalStatus) => {
    setLoading(true);
    try {
      await api(`/deals/${deal.id}`, {
        method: "PATCH",
        json: { proposalStatus: newStatus },
      });
      toast.success(`Proposal status updated to ${STATUS_LABELS[newStatus]}`);
      onUpdate();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update proposal status");
    } finally {
      setLoading(false);
    }
  };

  const actionButtons: Array<{ label: string; status: ProposalStatus; variant?: "default" | "outline" | "destructive" }> = (() => {
    switch (status) {
      case "not_started":
        return [{ label: "Start Drafting", status: "drafting" }];
      case "drafting":
        return [{ label: "Mark as Sent", status: "sent" }];
      case "sent":
        return [
          { label: "Under Review", status: "under_review" },
          { label: "Mark Rejected", status: "rejected", variant: "destructive" },
        ];
      case "under_review":
        return [
          { label: "Request Revision", status: "revision_requested", variant: "outline" },
          { label: "Mark Accepted", status: "accepted" },
          { label: "Mark Rejected", status: "rejected", variant: "destructive" },
        ];
      case "revision_requested":
        return [{ label: "Mark as Sent", status: "sent" }];
      case "accepted":
        return [{ label: "Mark as Signed", status: "signed" }];
      default:
        return [];
    }
  })();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Proposal Status
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Badge
          variant="outline"
          className={PROPOSAL_STATUS_COLORS[status]}
        >
          {STATUS_LABELS[status]}
        </Badge>

        <div className="text-xs text-muted-foreground space-y-1">
          {deal.proposalSentAt && (
            <p>Sent: {formatShortDate(deal.proposalSentAt)}</p>
          )}
          {deal.proposalAcceptedAt && (
            <p>Accepted: {formatShortDate(deal.proposalAcceptedAt)}</p>
          )}
          {(deal.proposalRevisionCount ?? 0) > 0 && (
            <p>Revisions: {deal.proposalRevisionCount}</p>
          )}
          <p className="italic">{HELPER_TEXT[status]}</p>
        </div>

        {actionButtons.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {actionButtons.map((btn) => (
              <Button
                key={btn.status}
                size="sm"
                variant={btn.variant ?? "default"}
                disabled={loading}
                onClick={() => updateStatus(btn.status)}
              >
                {btn.label}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
