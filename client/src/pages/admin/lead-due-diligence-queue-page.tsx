import { useState } from "react";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  approveLeadDueDiligenceApproval,
  rejectLeadDueDiligenceApproval,
  type LeadDueDiligenceApproval,
  useLeadDueDiligenceApprovals,
} from "@/hooks/use-lead-due-diligence";
import { isApiError } from "@/lib/api";
import { formatLeadBudgetStatus, formatLeadPocRole } from "@/lib/lead-display-labels";

type ApprovalStatus = "pending" | "approved" | "rejected";

const STATUS_TABS: Array<{ value: ApprovalStatus; label: string; empty: string }> = [
  { value: "pending", label: "Pending", empty: "No pending Due Diligence approvals." },
  { value: "approved", label: "Approved", empty: "No approved Due Diligence approvals." },
  { value: "rejected", label: "Rejected", empty: "No rejected Due Diligence approvals." },
];

function formatAddress(row: { property_address: string | null; property_city: string | null; property_state: string | null; property_zip: string | null }) {
  return [row.property_address, row.property_city, row.property_state, row.property_zip].filter(Boolean).join(", ");
}

function formatDateTime(value: string | null) {
  if (!value) return "Not provided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function getSignalDate(signal: Record<string, unknown> | null | undefined) {
  const raw = signal?.occurred_at ?? signal?.occurredAt;
  return typeof raw === "string" ? raw : null;
}

function formatDetection(signal: Record<string, unknown> | null | undefined) {
  const detail = typeof signal?.detail === "string" ? signal.detail : "No recent activity found";
  const occurredAt = getSignalDate(signal);
  return occurredAt ? `${detail} on ${formatDateTime(occurredAt)}` : detail;
}

function formatContact(approval: LeadDueDiligenceApproval) {
  const name = approval.primary_contact_name || "Not provided";
  const role = formatLeadPocRole(approval.primary_contact_role, approval.primary_contact_role_other_label);
  return approval.primary_contact_email
    ? `${name} (${role}) · ${approval.primary_contact_email}`
    : `${name} (${role})`;
}

function formatDecisionAttribution(approval: LeadDueDiligenceApproval) {
  const decidedAt = formatDateTime(approval.decided_at);
  if (approval.decided_by_name) {
    return `Decided by ${approval.decided_by_name} on ${decidedAt}`;
  }
  if (approval.decided_at) {
    return `Decided via email token on ${decidedAt}`;
  }
  return `Decided on ${decidedAt}`;
}

export function LeadDueDiligenceQueuePage() {
  const [status, setStatus] = useState<ApprovalStatus>("pending");
  const { approvals, loading, error, refetch } = useLeadDueDiligenceApprovals(status);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const approve = async (id: string) => {
    try {
      await approveLeadDueDiligenceApproval(id);
      toast.success("Due Diligence approved");
      await refetch();
    } catch (err) {
      if (isApiError(err) && err.status === 409) {
        toast.warning("This approval was already decided. Refreshing...");
        await refetch();
        return;
      }
      toast.error("Failed to approve. Please try again.");
    }
  };

  const reject = async (id: string) => {
    if (reason.trim().length < 10) {
      toast.error("Rejection reason must be at least 10 characters");
      return;
    }
    try {
      await rejectLeadDueDiligenceApproval(id, reason);
      toast.success("Due Diligence rejected");
      setRejectingId(null);
      setReason("");
      await refetch();
    } catch (err) {
      if (isApiError(err) && err.status === 409) {
        toast.warning("This approval was already decided. Refreshing...");
        setRejectingId(null);
        setReason("");
        await refetch();
        return;
      }
      toast.error("Failed to reject. Please try again.");
    }
  };

  const activeTab = STATUS_TABS.find((tab) => tab.value === status) ?? STATUS_TABS[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Lead Due Diligence Queue</h1>
        <p className="text-sm text-muted-foreground">Review new-customer leads before they can qualify.</p>
      </div>

      <div className="inline-flex border bg-background p-1">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              status === tab.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => {
              setStatus(tab.value);
              setRejectingId(null);
              setReason("");
            }}
          >
            {tab.label}{status === tab.value ? ` (${approvals.length})` : ""}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading approvals
        </div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : approvals.length === 0 ? (
        <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">{activeTab.empty}</div>
      ) : (
        <div className="space-y-4">
          {approvals.map((approval) => (
            <section key={approval.id} className="border bg-background p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">{approval.lead_name}</h2>
                  <p className="text-sm text-muted-foreground">{approval.company_name}</p>
                </div>
                {status === "pending" ? (
                  <div className="flex gap-2">
                    <Button onClick={() => void approve(approval.id)}>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Approve
                    </Button>
                    <Button variant="outline" onClick={() => setRejectingId(approval.id)}>
                      <XCircle className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                ) : null}
              </div>

              <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <div><dt className="font-medium">Contact</dt><dd>{formatContact(approval)}</dd></div>
                <div><dt className="font-medium">Property</dt><dd>{formatAddress(approval) || "Not provided"}</dd></div>
                <div><dt className="font-medium">Units / Year</dt><dd>{approval.unit_count ?? "?"} units · {approval.build_year ?? "?"}</dd></div>
                <div><dt className="font-medium">Project</dt><dd>{approval.project_type_name ?? "Not provided"}</dd></div>
                <div><dt className="font-medium">Budget / Bid due</dt><dd>{formatLeadBudgetStatus(approval.budget_status)} · {approval.bid_due_date ?? "Not provided"}</dd></div>
                <div><dt className="font-medium">Detection</dt><dd>{formatDetection(approval.detection_signal)}</dd></div>
                <div><dt className="font-medium">Requested by</dt><dd>{approval.requested_by_name ?? "Unknown"} · {formatDateTime(approval.requested_at)}</dd></div>
                <div><dt className="font-medium">Email</dt><dd>{approval.email_sent_at ? `Sent ${formatDateTime(approval.email_sent_at)}` : "Not sent"}</dd></div>
                {status !== "pending" ? (
                  <>
                    <div><dt className="font-medium">Decision</dt><dd>{formatDecisionAttribution(approval)}</dd></div>
                    <div><dt className="font-medium">Reason</dt><dd>{approval.decision_reason ?? "Not provided"}</dd></div>
                  </>
                ) : null}
              </dl>

              {status === "pending" && rejectingId === approval.id ? (
                <div className="mt-4 space-y-2">
                  <label className="text-sm font-medium" htmlFor={`reject-${approval.id}`}>Rejection reason</label>
                  <textarea
                    id={`reject-${approval.id}`}
                    className="min-h-24 w-full border bg-background p-2 text-sm"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button variant="destructive" onClick={() => void reject(approval.id)}>Confirm Reject</Button>
                    <Button variant="outline" onClick={() => setRejectingId(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
