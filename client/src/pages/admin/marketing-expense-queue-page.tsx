import { useState } from "react";
import { CheckCircle, Inbox, Loader2, Megaphone, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api";
import {
  decideMarketingExpenseRequest,
  useMarketingExpenseQueue,
  type MarketingExpenseQueueStatus,
} from "@/hooks/use-marketing-expense-requests";
import { formatMoney, type MarketingExpenseRequestSummary } from "@trock-crm/shared/types";

/**
 * The approver queue.
 *
 * Modelled on pages/admin/lead-due-diligence-queue-page.tsx: a tab bar with a count on the ACTIVE tab, an
 * inline deny-with-reason textarea with a client-side minimum, and 409-already-decided handling that toasts
 * and refetches rather than showing an error — two approvers opening the same email and both clicking is
 * the normal case here, not an edge case.
 *
 * The count sits on the active tab only because that is the only status this page has loaded. A number on
 * an inactive tab would be either stale or invented.
 */

const MINIMUM_DENIAL_REASON = 10;

const STATUS_TABS: Array<{ value: MarketingExpenseQueueStatus; label: string; empty: string }> = [
  { value: "pending", label: "Pending", empty: "No pending expense requests." },
  { value: "approved", label: "Approved", empty: "No approved expense requests." },
  { value: "denied", label: "Denied", empty: "No denied expense requests." },
  { value: "withdrawn", label: "Withdrawn", empty: "No withdrawn expense requests." },
];

function formatDate(value: string | null): string {
  if (!value) return "Not specified";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not specified" : date.toLocaleDateString();
}

export function MarketingExpenseQueuePage() {
  const [status, setStatus] = useState<MarketingExpenseQueueStatus>("pending");
  const { requests, loading, error, refetch } = useMarketingExpenseQueue(status);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeTab = STATUS_TABS.find((tab) => tab.value === status) ?? STATUS_TABS[0]!;

  function clearDenial() {
    setDenyingId(null);
    setReason("");
  }

  /** True when the failure means "somebody else got here first", which is a refetch and not an error. */
  function handleFailure(err: unknown): boolean {
    if (isApiError(err) && err.status === 409) {
      toast.warning("This request was already decided. Refreshing...");
      clearDenial();
      void refetch();
      return true;
    }
    toast.error(err instanceof Error ? err.message : "Could not record the decision.");
    return false;
  }

  async function approve(request: MarketingExpenseRequestSummary) {
    setBusyId(request.id);
    try {
      await decideMarketingExpenseRequest(request.id, "approved");
      toast.success(`${request.requestNumber} approved`);
      await refetch();
    } catch (err) {
      handleFailure(err);
    } finally {
      setBusyId(null);
    }
  }

  async function deny(request: MarketingExpenseRequestSummary) {
    // The server requires a reason too. Checking here as well is what turns "400 Bad Request" into a
    // sentence next to the box the approver is already typing in.
    if (reason.trim().length < MINIMUM_DENIAL_REASON) {
      toast.error(`Denial reason must be at least ${MINIMUM_DENIAL_REASON} characters`);
      return;
    }
    setBusyId(request.id);
    try {
      await decideMarketingExpenseRequest(request.id, "denied", reason.trim());
      toast.success(`${request.requestNumber} denied`);
      clearDenial();
      await refetch();
    } catch (err) {
      handleFailure(err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-red/10 text-brand-red">
            <Megaphone className="h-5 w-5" />
          </span>
          <h1 className="text-2xl font-bold">Marketing Expense Requests</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Approve or deny marketing &amp; advertising spend before it is committed.
        </p>
      </div>

      <div className="inline-flex border bg-background p-1">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            data-testid={`mer-tab-${tab.value}`}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              status === tab.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => {
              setStatus(tab.value);
              clearDenial();
            }}
          >
            {tab.label}
            {status === tab.value ? ` (${requests.length})` : ""}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading expense requests
        </div>
      ) : error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : requests.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/40 px-4 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <Inbox className="h-6 w-6" />
          </span>
          <p className="text-sm text-muted-foreground">{activeTab.empty}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <section
              key={request.id}
              data-testid={`mer-queue-row-${request.id}`}
              className="border bg-background p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {request.requestNumber} — {request.vendorEvent}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {request.submittedByName ?? "Unknown"} · {formatMoney(request.totalRequested)}
                  </p>
                </div>
                {status === "pending" ? (
                  <div className="flex gap-2">
                    <Button
                      data-testid={`mer-approve-${request.id}`}
                      disabled={busyId === request.id}
                      onClick={() => void approve(request)}
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      data-testid={`mer-deny-${request.id}`}
                      disabled={busyId === request.id}
                      onClick={() => setDenyingId(request.id)}
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Deny
                    </Button>
                  </div>
                ) : null}
              </div>

              <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <div>
                  <dt className="font-medium">Total requested</dt>
                  <dd>{formatMoney(request.totalRequested)}</dd>
                </div>
                <div>
                  <dt className="font-medium">Needed by</dt>
                  <dd>{formatDate(request.neededBy)}</dd>
                </div>
                <div>
                  <dt className="font-medium">Submitted</dt>
                  <dd>{formatDate(request.submittedAt)}</dd>
                </div>
                {request.latestDecision ? (
                  <div>
                    <dt className="font-medium">Decision</dt>
                    <dd>
                      {request.latestDecision === "approved" ? "Approved" : "Denied"}
                      {request.latestDecidedByName ? ` by ${request.latestDecidedByName}` : ""}
                      {request.latestDecisionReason ? ` — ${request.latestDecisionReason}` : ""}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {status === "pending" && denyingId === request.id ? (
                <div className="mt-4 space-y-2">
                  <label className="text-sm font-medium" htmlFor={`mer-deny-reason-${request.id}`}>
                    Denial reason
                  </label>
                  <textarea
                    id={`mer-deny-reason-${request.id}`}
                    data-testid="mer-deny-reason"
                    className="min-h-24 w-full border bg-background p-2 text-sm"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      data-testid={`mer-confirm-deny-${request.id}`}
                      disabled={busyId === request.id}
                      onClick={() => void deny(request)}
                    >
                      Confirm deny
                    </Button>
                    <Button variant="outline" onClick={clearDenial}>
                      Cancel
                    </Button>
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
