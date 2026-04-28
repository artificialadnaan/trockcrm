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

// TODO proposal drafting deferred pieces: templates, version history, e-sign.
interface DealProposalCardProps {
  deal: DealDetail;
  onUpdate: () => void;
  onOpenProposalEditor?: () => void;
  proposalDraftingEnabled?: boolean;
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

type ProposalActionButton = {
  label: string;
  status: ProposalStatus;
  variant?: "default" | "outline" | "destructive";
  action?: "start_draft" | "status";
};

export function resolveProposalDraftingEnabled(
  env: Record<string, string | boolean | undefined> =
    ((import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {})
) {
  return env.PROPOSAL_DRAFTING_ENABLED === true || env.PROPOSAL_DRAFTING_ENABLED === "true";
}

export function DealProposalCard({
  deal,
  onUpdate,
  onOpenProposalEditor,
  proposalDraftingEnabled = resolveProposalDraftingEnabled(),
}: DealProposalCardProps) {
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

  const startDrafting = async () => {
    if (!proposalDraftingEnabled) {
      return;
    }

    setLoading(true);
    try {
      await api(`/deals/${deal.id}/proposal-draft`, {
        method: "POST",
      });
      toast.success("Proposal draft started");
      onUpdate();
      onOpenProposalEditor?.();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to start proposal draft");
    } finally {
      setLoading(false);
    }
  };

  const actionButtons: ProposalActionButton[] = (() => {
    switch (status) {
      case "not_started":
        return [{ label: "Start Drafting", status: "drafting", action: "start_draft" }];
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
                title={btn.action === "start_draft" && !proposalDraftingEnabled ? "Coming soon" : undefined}
                onClick={() => {
                  if (btn.action === "start_draft") {
                    void startDrafting();
                    return;
                  }
                  void updateStatus(btn.status);
                }}
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
