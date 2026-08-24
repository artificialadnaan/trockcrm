import { useState } from "react";
import { CheckCircle, ChevronDown, ChevronRight, Inbox, Loader2, Megaphone, Paperclip, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api";
import {
  decideMarketingExpenseRequest,
  getMarketingExpenseRequest,
  useMarketingExpenseQueue,
  type MarketingExpenseQueueStatus,
} from "@/hooks/use-marketing-expense-requests";
import {
  MARKETING_EXPENSE_ATTACHMENT_KIND_LABELS,
  MARKETING_EXPENSE_COST_FIELDS,
  MARKETING_EXPENSE_COST_LABELS,
  MARKETING_EXPENSE_PAYMENT_METHOD_LABELS,
  formatDateOnly,
  formatMoney,
  type MarketingExpenseAttachmentKind,
  type MarketingExpenseCostField,
  type MarketingExpensePaymentMethod,
  type MarketingExpenseRequestDetail,
  type MarketingExpenseRequestSummary,
} from "@trock-crm/shared/types";

/**
 * The approver queue.
 *
 * A DECISION REQUIRES READING THE REQUEST. Approve and Deny do not exist on a summary row — the approver
 * opens the request first, and only then can decide. This form's entire purpose is "what is this for and
 * what does TRC get back"; deciding from a row is deciding on a number attached to a name, and the two
 * fields that justify the spend are the two the row cannot show.
 *
 * DENIAL REASONS ARE PER ROW. One page-level string meant a reason typed for request A stayed in the box
 * when the approver opened request B, and B could be denied with A's explanation attached — recorded on the
 * request and emailed to its submitter. The reason is keyed to the request it was typed for.
 *
 * 409-already-decided toasts and refetches rather than erroring: two approvers opening the same email and
 * both clicking is the normal case here, not an edge case.
 */

const MINIMUM_DENIAL_REASON = 10;

const STATUS_TABS: Array<{ value: MarketingExpenseQueueStatus; label: string; empty: string }> = [
  { value: "pending", label: "Pending", empty: "No pending expense requests." },
  { value: "approved", label: "Approved", empty: "No approved expense requests." },
  { value: "denied", label: "Denied", empty: "No denied expense requests." },
  { value: "withdrawn", label: "Withdrawn", empty: "No withdrawn expense requests." },
];

/** A real timestamptz — the zone-aware path is correct here. */
function formatInstant(value: string | null): string {
  if (!value) return "Not specified";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not specified" : date.toLocaleDateString();
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-slate-800">{value}</dd>
    </div>
  );
}

function RequestDetail({ detail }: { detail: MarketingExpenseRequestDetail }) {
  const costRows = MARKETING_EXPENSE_COST_FIELDS.map((field) => {
    const custom =
      field === "costOther1"
        ? detail.costOther1Label
        : field === "costOther2"
          ? detail.costOther2Label
          : null;
    return {
      field,
      label: custom?.trim() || MARKETING_EXPENSE_COST_LABELS[field as MarketingExpenseCostField],
      amount: detail[field as MarketingExpenseCostField],
    };
  }).filter((row) => Number(row.amount) > 0);

  return (
    <div data-testid={`mer-detail-${detail.id}`} className="mt-4 space-y-5 border-t pt-4">
      <dl className="grid gap-4 text-sm md:grid-cols-2">
        <DetailRow label="Requested by" value={detail.requestedByName} />
        <DetailRow label="Department" value={detail.department || "Not specified"} />
        <DetailRow label="Location & dates" value={detail.locationDates || "Not specified"} />
        <DetailRow label="Needed by" value={formatDateOnly(detail.neededBy)} />
      </dl>

      <div className="space-y-3 text-sm">
        <DetailRow label="What is the request for?" value={detail.purpose} />
        <DetailRow label="What will TRC receive in return?" value={detail.expectedReturn} />
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Estimated cost
        </p>
        <table className="w-full text-sm">
          <tbody>
            {costRows.length === 0 ? (
              <tr>
                <td className="py-1 text-muted-foreground">No individual cost lines</td>
              </tr>
            ) : (
              costRows.map((row) => (
                <tr key={row.field} className="border-b last:border-b-0">
                  <td className="py-1.5 text-slate-700">{row.label}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoney(row.amount)}
                  </td>
                </tr>
              ))
            )}
            <tr className="border-t-2">
              <td className="py-1.5 font-semibold text-slate-900">Total requested</td>
              <td className="py-1.5 text-right font-semibold tabular-nums text-slate-900">
                {formatMoney(detail.totalRequested)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <dl className="grid gap-4 text-sm md:grid-cols-2">
        <DetailRow label="Budget / job code" value={detail.budgetJobCode || "Not specified"} />
        <DetailRow
          label="Payment method"
          value={
            detail.paymentMethod
              ? MARKETING_EXPENSE_PAYMENT_METHOD_LABELS[
                  detail.paymentMethod as MarketingExpensePaymentMethod
                ]
              : "Not specified"
          }
        />
        <DetailRow label="Travel required" value={detail.travelRequired ? "Yes" : "No"} />
        <DetailRow label="Attendees" value={detail.attendees || "Not specified"} />
        <DetailRow label="Business meetings" value={detail.businessMeetings || "Not specified"} />
        <DetailRow
          label="Declared attachments"
          value={
            detail.attachmentKinds.length > 0
              ? detail.attachmentKinds
                  .map(
                    (kind) =>
                      MARKETING_EXPENSE_ATTACHMENT_KIND_LABELS[kind as MarketingExpenseAttachmentKind],
                  )
                  .join(", ")
              : "None declared"
          }
        />
      </dl>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Supporting documents
        </p>
        {detail.attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No supporting documents were attached.</p>
        ) : (
          <ul className="space-y-1">
            {detail.attachments.map((attachment) => (
              <li key={attachment.id} className="flex items-center gap-2 text-sm text-slate-700">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{attachment.displayName}</span>
                <span className="text-xs text-muted-foreground">
                  {Math.max(1, Math.round(attachment.fileSizeBytes / 1024))} KB
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function MarketingExpenseQueuePage() {
  const [status, setStatus] = useState<MarketingExpenseQueueStatus>("pending");
  const { requests, loading, error, refetch } = useMarketingExpenseQueue(status);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketingExpenseRequestDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  // Keyed by request id: a reason typed for one request must never be submitted against another.
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeTab = STATUS_TABS.find((tab) => tab.value === status) ?? STATUS_TABS[0]!;

  function closeAll() {
    setOpenId(null);
    setDetail(null);
    setDenyingId(null);
  }

  async function toggleReview(request: MarketingExpenseRequestSummary) {
    if (openId === request.id) {
      closeAll();
      return;
    }
    setOpenId(request.id);
    setDetail(null);
    setDenyingId(null);
    setLoadingDetailId(request.id);
    try {
      setDetail(await getMarketingExpenseRequest(request.id));
    } catch (err) {
      // The decision stays unavailable: `detail` is still null, so no Approve/Deny renders.
      toast.error(err instanceof Error ? err.message : "Could not load the request.");
    } finally {
      setLoadingDetailId(null);
    }
  }

  /** True when the failure means "somebody else got here first", which is a refetch and not an error. */
  function handleFailure(err: unknown): boolean {
    if (isApiError(err) && err.status === 409) {
      toast.warning("This request was already decided. Refreshing...");
      closeAll();
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
      closeAll();
      await refetch();
    } catch (err) {
      handleFailure(err);
    } finally {
      setBusyId(null);
    }
  }

  async function deny(request: MarketingExpenseRequestSummary) {
    const reason = (reasons[request.id] ?? "").trim();
    // The server requires a reason too. Checking here as well is what turns "400 Bad Request" into a
    // sentence next to the box the approver is already typing in.
    if (reason.length < MINIMUM_DENIAL_REASON) {
      toast.error(`Denial reason must be at least ${MINIMUM_DENIAL_REASON} characters`);
      return;
    }
    setBusyId(request.id);
    try {
      await decideMarketingExpenseRequest(request.id, "denied", reason);
      toast.success(`${request.requestNumber} denied`);
      setReasons((current) => ({ ...current, [request.id]: "" }));
      closeAll();
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
          Open a request to read what it is for, then approve or deny it.
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
              closeAll();
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
          {requests.map((request) => {
            const isOpen = openId === request.id;
            const loadedDetail = isOpen && detail?.id === request.id ? detail : null;
            const canDecide = status === "pending" && Boolean(loadedDetail);
            return (
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
                      {request.submittedByName ?? "Unknown"} · {formatMoney(request.totalRequested)} ·
                      needed by {formatDateOnly(request.neededBy)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    data-testid={`mer-review-${request.id}`}
                    disabled={loadingDetailId === request.id}
                    onClick={() => void toggleReview(request)}
                  >
                    {isOpen ? (
                      <ChevronDown className="mr-2 h-4 w-4" />
                    ) : (
                      <ChevronRight className="mr-2 h-4 w-4" />
                    )}
                    {loadingDetailId === request.id
                      ? "Opening…"
                      : isOpen
                        ? "Close"
                        : status === "pending"
                          ? "Review request"
                          : "View request"}
                  </Button>
                </div>

                <dl className="mt-3 grid gap-3 text-sm md:grid-cols-3">
                  <div>
                    <dt className="font-medium">Total requested</dt>
                    <dd>{formatMoney(request.totalRequested)}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Submitted</dt>
                    <dd>{formatInstant(request.submittedAt)}</dd>
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

                {loadedDetail ? <RequestDetail detail={loadedDetail} /> : null}

                {canDecide ? (
                  <div className="mt-4 flex gap-2 border-t pt-4">
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

                {canDecide && denyingId === request.id ? (
                  <div className="mt-4 space-y-2">
                    <label className="text-sm font-medium" htmlFor={`mer-deny-reason-${request.id}`}>
                      Denial reason
                    </label>
                    <textarea
                      id={`mer-deny-reason-${request.id}`}
                      data-testid="mer-deny-reason"
                      className="min-h-24 w-full border bg-background p-2 text-sm"
                      value={reasons[request.id] ?? ""}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [request.id]: event.target.value }))
                      }
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
                      <Button variant="outline" onClick={() => setDenyingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
